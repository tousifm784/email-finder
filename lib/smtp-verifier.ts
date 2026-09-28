import { lookup, resolveMx } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { normalizeDomain } from "@/lib/domain";
import { generatePermutations } from "@/lib/permutations";

export type SmtpProbe = { email: string; code: number | null; message: string };
export type VerificationStatus = "deliverable" | "catch_all" | "risky" | "undeliverable" | "domain_invalid" | "pattern_prediction";
export type VerificationProgress = "generating" | "mx" | "smtp" | "catch_all" | "complete";

export type VerificationResult = {
  status: VerificationStatus;
  email: string | null;
  confidence: number;
  domain: string;
  mxHost: string | null;
  provider: string;
  catchAll: boolean | null;
  badge: string | null;
  patternBadge: string | null;
  predictions: string[];
  pattern: string | null;
  observedEmails: string[];
  message: string;
  checkedAt: string;
  probes: SmtpProbe[];
};

type SmtpResponse = { code: number; message: string };

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value !== "::" && value !== "::1" && !value.startsWith("fc") && !value.startsWith("fd") && !value.startsWith("fe8") && !value.startsWith("fe9") && !value.startsWith("fea") && !value.startsWith("feb") && !value.startsWith("::ffff:");
  }
  return false;
}

function classifyProvider(host: string, domain: string): string {
  const value = host.toLowerCase();
  if (domain === "linkedin.com" || domain.endsWith(".linkedin.com") || value.includes("linkedin")) return "LinkedIn Enterprise Gateway";
  if (value.endsWith(".google.com") || value.endsWith(".googlemail.com")) return "Google Workspace";
  if (value.includes("outlook.com") || value.includes("protection.outlook")) return "Microsoft 365";
  if (value.includes("proofpoint") || value.endsWith(".pphosted.com")) return "Proofpoint";
  if (value.includes("mimecast")) return "Mimecast";
  if (value.includes("zoho")) return "Zoho Mail";
  return "Custom mail server";
}

function isEnterpriseGateway(provider: string): boolean {
  return ["LinkedIn Enterprise Gateway", "Google Workspace", "Microsoft 365", "Proofpoint", "Mimecast"].includes(provider);
}

function isPort25Restricted(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return ["EACCES", "EPERM", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code) || /SMTP connection timed out/i.test(message);
}

function isAntiAbuseRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\((421|554)\)/.test(message);
}

class SmtpSession {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{ resolve: (response: SmtpResponse) => void; reject: (error: Error) => void }> = [];

  constructor(private readonly socket: Socket, timeoutMs: number) {
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("timeout", () => this.rejectAll(new Error("SMTP connection timed out.")));
    socket.on("close", () => this.rejectAll(new Error("SMTP connection closed.")));
  }

  read(): Promise<SmtpResponse> {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async command(command: string): Promise<SmtpResponse> {
    const response = this.read();
    this.socket.write(`${command}\r\n`);
    return response;
  }

  end(): void {
    this.socket.end();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      this.lines.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        const message = this.lines.join(" | ").slice(0, 500);
        this.lines = [];
        this.waiters.shift()?.resolve({ code, message });
      }
    }
  }

  private rejectAll(error: Error): void {
    while (this.waiters.length) this.waiters.shift()?.reject(error);
  }
}

async function getPublicMxHost(domain: string): Promise<{ host: string; address: string; provider: string }> {
  const records = await resolveMx(domain);
  if (!records.length || records.every(({ exchange }) => !exchange || exchange === ".")) {
    throw new Error("No MX records found for this domain.");
  }
  records.sort((left, right) => left.priority - right.priority);
  for (const record of records) {
    const addresses = await lookup(record.exchange, { all: true }).catch(() => []);
    const publicAddress = addresses.find(({ address }) => isPublicAddress(address))?.address;
    if (publicAddress) {
      return { host: record.exchange.replace(/\.$/, ""), address: publicAddress, provider: classifyProvider(record.exchange, domain) };
    }
  }
  throw new Error("The domain's mail servers did not resolve to public IP addresses.");
}

async function probeMx(
  host: string,
  address: string,
  domain: string,
  candidates: string[],
  onProgress: (phase: VerificationProgress) => void | Promise<void>,
): Promise<{ catchAll: boolean; catchCode: number; probes: SmtpProbe[] }> {
  const timeoutMs = Math.min(Math.max(Number(process.env.SMTP_TIMEOUT_MS) || 7000, 1000), 15000);
  const heloDomain = normalizeDomain(process.env.SMTP_HELO_DOMAIN || "");
  const fromAddress = process.env.SMTP_FROM_ADDRESS || "";
  if (!fromAddress.endsWith(`@${heloDomain}`)) throw new Error("SMTP_FROM_ADDRESS must use the configured SMTP_HELO_DOMAIN.");

  const socket = new Socket();
  socket.setTimeout(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("timeout", onTimeout);
      reject(error);
    };
    const onTimeout = () => {
      socket.off("error", onError);
      socket.destroy();
      reject(new Error("SMTP connection timed out."));
    };
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.connect(25, address, () => {
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      resolve();
    });
  });
  const session = new SmtpSession(socket, timeoutMs);
  try {
    const greeting = await session.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting rejected (${greeting.code}).`);
    let response = await session.command(`EHLO ${heloDomain}`);
    if (response.code === 421 || response.code === 554) throw new Error(`SMTP greeting rejected (${response.code}).`);
    if (response.code !== 250) response = await session.command(`HELO ${heloDomain}`);
    if (response.code !== 250) throw new Error(`SMTP greeting rejected (${response.code}).`);

    response = await session.command(`MAIL FROM:<${fromAddress}>`);
    if (response.code < 200 || response.code >= 300) throw new Error(`Sender rejected (${response.code}).`);

    await onProgress("catch_all");
    const randomAddress = `${randomUUID()}@${domain}`;
    const catchResponse = await session.command(`RCPT TO:<${randomAddress}>`);
    const catchAll = catchResponse.code >= 200 && catchResponse.code < 300;
    await session.command("RSET").catch(() => ({ code: 0, message: "Reset failed" }));

    const probes: SmtpProbe[] = [];
    for (const email of catchAll || [421, 554].includes(catchResponse.code) ? [] : candidates) {
      const sender = await session.command(`MAIL FROM:<${fromAddress}>`);
      if (sender.code < 200 || sender.code >= 300) {
        probes.push({ email, code: sender.code, message: sender.message });
        break;
      }
      const result = await session.command(`RCPT TO:<${email}>`);
      probes.push({ email, code: result.code, message: result.message });
      await session.command("RSET").catch(() => ({ code: 0, message: "Reset failed" }));
      if ([421, 554].includes(result.code)) break;
    }

    await session.command("QUIT").catch(() => ({ code: 0, message: "Quit failed" }));
    return { catchAll, catchCode: catchResponse.code, probes };
  } finally {
    session.end();
  }
}

function emptyResult(domain: string, status: VerificationStatus, message: string): VerificationResult {
  return { status, email: null, confidence: 0, domain, mxHost: null, provider: "Unknown", catchAll: null, badge: null, patternBadge: null, predictions: [], pattern: null, observedEmails: [], message, checkedAt: new Date().toISOString(), probes: [] };
}

function patternPredictionResult(
  status: "catch_all" | "pattern_prediction",
  domain: string,
  mxHost: string,
  provider: string,
  candidates: string[],
  badge: string,
  message: string,
  catchAll: boolean | null,
): VerificationResult {
  return {
    status,
    email: candidates[0] ?? null,
    confidence: status === "catch_all" ? 64 : 54,
    domain,
    mxHost,
    provider,
    catchAll,
    badge,
    patternBadge: null,
    predictions: candidates,
    pattern: null,
    observedEmails: [],
    message,
    checkedAt: new Date().toISOString(),
    probes: [],
  };
}

export async function verifyWithRemoteWorker(
  mxHost: string,
  domain: string,
  candidates: string[],
): Promise<{ probes: SmtpProbe[]; catchAll: boolean } | null> {
  const workerUrl = process.env.SMTP_WORKER_URL;
  if (!workerUrl) return null;

  const response = await fetch(workerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SMTP_WORKER_TOKEN ? { authorization: `Bearer ${process.env.SMTP_WORKER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ domain, mxHost, candidates }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Remote SMTP worker returned HTTP ${response.status}.`);
  const body = await response.json() as {
    probes?: Array<{ email?: string; code?: number | null; message?: string }>;
    results?: Array<{ email?: string; code?: number | null; message?: string }>;
    catchAll?: boolean;
  };
  const rows = body.probes ?? body.results;
  if (!Array.isArray(rows)) throw new Error("Remote SMTP worker returned an invalid response.");
  const candidateSet = new Set(candidates);
  const probes = rows.flatMap((row) => {
    if (!row.email || !candidateSet.has(row.email) || (row.code !== null && typeof row.code !== "number")) return [];
    return [{ email: row.email, code: row.code ?? null, message: String(row.message ?? "Remote SMTP response").slice(0, 500) }];
  });
  return { probes, catchAll: body.catchAll === true };
}

export async function verifyDomainAndCandidates(
  name: string,
  rawDomain: string,
  onProgress: (phase: VerificationProgress) => void | Promise<void> = () => undefined,
): Promise<VerificationResult> {
  let domain: string;
  try {
    domain = normalizeDomain(rawDomain);
  } catch (error) {
    return emptyResult(rawDomain, "domain_invalid", error instanceof Error ? error.message : "Invalid domain.");
  }

  await onProgress("generating");
  let candidates: string[];
  try {
    candidates = generatePermutations(name, domain);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid name.");
  }

  await onProgress("mx");
  let mx: { host: string; address: string; provider: string };
  try {
    mx = await getPublicMxHost(domain);
  } catch (error) {
    return emptyResult(domain, "domain_invalid", error instanceof Error ? error.message : "MX lookup failed.");
  }

  if (process.env.SMTP_WORKER_URL) {
    await onProgress("smtp");
    try {
      const remote = await verifyWithRemoteWorker(mx.host, domain, candidates);
      if (!remote) throw new Error("Remote SMTP worker is not configured.");
      const accepted = remote.probes.find((probe) => probe.code === 250 || probe.code === 251);
      if (remote.catchAll) {
        return {
          ...patternPredictionResult("catch_all", domain, mx.host, mx.provider, candidates, "Enterprise Protected / Predicted Pattern", "The remote worker detected a catch-all gateway. Individual mailboxes cannot be confirmed.", true),
          probes: remote.probes,
        };
      }
      if (accepted) return { ...emptyResult(domain, "deliverable", "Remote SMTP worker accepted this recipient (250). No message was sent."), email: accepted.email, confidence: 97, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: "Deliverable (250 OK)", probes: remote.probes };
      const hardRejected = remote.probes.length > 0 && remote.probes.every((probe) => probe.code !== null && probe.code >= 500);
      if (hardRejected) return { ...emptyResult(domain, "undeliverable", "The remote SMTP worker rejected all candidate recipients."), confidence: 96, mxHost: mx.host, provider: mx.provider, catchAll: false, probes: remote.probes };
      return patternPredictionResult("pattern_prediction", domain, mx.host, mx.provider, candidates, "Remote SMTP Inconclusive / Predicted Pattern", "The remote worker did not receive a conclusive recipient response.", false);
    } catch (error) {
      return patternPredictionResult("pattern_prediction", domain, mx.host, mx.provider, candidates, "Remote SMTP Unavailable / Predicted Pattern", error instanceof Error ? error.message : "Remote verification unavailable.", null);
    }
  }

  if (process.env.SMTP_PROBING_ENABLED !== "true") {
    return patternPredictionResult(
      "pattern_prediction",
      domain,
      mx.host,
      mx.provider,
      candidates,
      "PATTERN_PREDICTION (Port 25 Restricted / Dev Mode)",
      "SMTP is disabled or unavailable in this environment. These candidates are ranked by common enterprise patterns and are not verified.",
      null,
    );
  }

  await onProgress("smtp");
  try {
    const result = await probeMx(mx.host, mx.address, domain, candidates, onProgress);
    const policyRejected = result.catchCode === 421 || result.catchCode === 554 || result.probes.some((probe) => probe.code === 421 || probe.code === 554);
    if (policyRejected) {
      const badge = isEnterpriseGateway(mx.provider)
        ? "Enterprise Protected / Predicted Pattern"
        : "SMTP Policy Restricted / Predicted Pattern";
      return patternPredictionResult("pattern_prediction", domain, mx.host, mx.provider, candidates, badge, `The mail gateway rejected recipient probing with ${result.catchCode === 421 || result.catchCode === 554 ? result.catchCode : "421/554"}. No candidate could be verified.`, false);
    }
    const accepted = result.probes.find((probe) => probe.code === 250 || probe.code === 251);
    const transient = result.probes.some((probe) => probe.code === null || probe.code === 421 || (probe.code !== null && probe.code >= 400 && probe.code < 500));
    const rejected = result.probes.length > 0 && result.probes.every((probe) => probe.code !== null && probe.code >= 500);
    if (result.catchAll) {
      const badge = isEnterpriseGateway(mx.provider)
        ? "Enterprise Protected / Predicted Pattern"
        : "Catch-all / Predicted Pattern";
      return {
        ...patternPredictionResult("catch_all", domain, mx.host, mx.provider, candidates, badge, "The server accepted a randomized recipient. Individual mailboxes cannot be confirmed on a catch-all domain.", true),
        probes: result.probes,
      };
    }
    if (accepted) {
      return { status: "deliverable", email: accepted.email, confidence: 97, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: "Deliverable (250 OK)", patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "The mail server accepted this recipient during an SMTP handshake. No message was sent.", checkedAt: new Date().toISOString(), probes: result.probes };
    }
    if (rejected && !transient) {
      return { status: "undeliverable", email: null, confidence: 96, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: null, patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "All tested patterns were rejected by the mail server.", checkedAt: new Date().toISOString(), probes: result.probes };
    }
    return { status: "risky", email: null, confidence: 38, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: null, patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "The mail server deferred or refused verification. Results are inconclusive.", checkedAt: new Date().toISOString(), probes: result.probes };
  } catch (error) {
    if (isAntiAbuseRejection(error)) {
      const badge = isEnterpriseGateway(mx.provider)
        ? "Enterprise Protected / Predicted Pattern"
        : "SMTP Policy Restricted / Predicted Pattern";
      return patternPredictionResult("pattern_prediction", domain, mx.host, mx.provider, candidates, badge, "The mail gateway rejected the SMTP handshake with an anti-abuse response. No candidate could be verified.", false);
    }
    if (isPort25Restricted(error)) {
      return patternPredictionResult(
        "pattern_prediction",
        domain,
        mx.host,
        mx.provider,
        candidates,
        "PATTERN_PREDICTION (Port 25 Restricted / Dev Mode)",
        "Outbound SMTP on port 25 is blocked or unavailable. These candidates are ranked by common enterprise patterns and are not verified.",
        null,
      );
    }
    return { ...emptyResult(domain, "risky", error instanceof Error ? error.message : "SMTP verification failed."), mxHost: mx.host, provider: mx.provider };
  }
}