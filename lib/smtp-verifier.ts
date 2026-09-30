import { resolveTxt } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { normalizeDomain } from "@/lib/domain";
import { generatePermutations } from "@/lib/permutations";
import { classifySmtpResponse, resolvePublicMxHost, runSmtpHandshake, type SmtpProbe } from "@/lib/smtp-engine";

export type { SmtpProbe } from "@/lib/smtp-engine";

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
  spf?: string | null;
  dmarc?: string | null;
  predictionStatuses?: string[];
};

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

function emptyResult(domain: string, status: VerificationStatus, message: string): VerificationResult {
  return { status, email: null, confidence: 0, domain, mxHost: null, provider: "Unknown", catchAll: null, badge: null, patternBadge: null, predictions: [], pattern: null, observedEmails: [], message, checkedAt: new Date().toISOString(), probes: [] };
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
    body: JSON.stringify({ domain, mxHost, catchAllProbe: `catchall_probe_${randomUUID().replaceAll("-", "")}@${domain}`, candidates }),
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
  return {
    probes: probes.map((probe) => ({ ...probe, status: classifySmtpResponse(probe.code) })),
    catchAll: body.catchAll === true,
  };
}

async function verifyDomainAndCandidatesCore(
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
    mx = await resolvePublicMxHost(domain);
  } catch (error) {
    return emptyResult(domain, "domain_invalid", error instanceof Error ? error.message : "MX lookup failed.");
  }

  if (process.env.SMTP_WORKER_URL) {
    await onProgress("smtp");
    try {
      const remote = await verifyWithRemoteWorker(mx.host, domain, candidates);
      if (!remote) throw new Error("Remote SMTP worker is not configured.");
      if (remote.catchAll) {
        return { ...emptyResult(domain, "catch_all", "The remote worker detected a catch-all gateway. Individual mailbox checks were not run."), mxHost: mx.host, provider: mx.provider, catchAll: true, badge: "Catch-all detected", probes: [] };
      }
      const accepted = remote.probes.find((probe) => probe.code === 250);
      if (accepted) return { ...emptyResult(domain, "deliverable", "Remote SMTP worker accepted this recipient (250). No message was sent."), email: accepted.email, confidence: 99, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: "Deliverable (250 OK)", probes: remote.probes };
      const hardRejected = remote.probes.length > 0 && remote.probes.every((probe) => probe.status === "invalid");
      if (hardRejected) return { ...emptyResult(domain, "undeliverable", "The remote SMTP worker rejected all candidate recipients."), confidence: 96, mxHost: mx.host, provider: mx.provider, catchAll: false, probes: remote.probes };
      return { ...emptyResult(domain, "risky", "The remote worker did not receive a conclusive recipient response. No candidate was selected."), mxHost: mx.host, provider: mx.provider, catchAll: false, probes: remote.probes };
    } catch (error) {
      return { ...emptyResult(domain, "risky", error instanceof Error ? error.message : "Remote verification unavailable. No candidate was selected."), mxHost: mx.host, provider: mx.provider };
    }
  }

  if (process.env.SMTP_PROBING_ENABLED === "false") {
    return { ...emptyResult(domain, "risky", "SMTP verification is disabled. No candidate was selected."), mxHost: mx.host, provider: mx.provider };
  }

  await onProgress("smtp");
  try {
    const result = await runSmtpHandshake(mx, domain, candidates, () => onProgress("catch_all"));
    if (result.catchAll) {
      return { ...emptyResult(domain, "catch_all", "The server accepted a randomized recipient. Individual mailbox checks were not run."), mxHost: mx.host, provider: mx.provider, catchAll: true, badge: "Catch-all detected", probes: [] };
    }
    if (result.catchProbe.status !== "invalid") {
      return { ...emptyResult(domain, "risky", `The catch-all probe was inconclusive (${result.catchProbe.code ?? "no response"}). Candidate checks were not run.`), mxHost: mx.host, provider: mx.provider, catchAll: null, probes: [result.catchProbe] };
    }
    const accepted = result.probes.find((probe) => probe.code === 250);
    if (accepted) {
      return { status: "deliverable", email: accepted.email, confidence: 99, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: "Deliverable (250 OK)", patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "The mail server accepted this recipient during an SMTP handshake. No message was sent.", checkedAt: new Date().toISOString(), probes: result.probes };
    }
    if (result.probes.length === candidates.length && result.probes.every((probe) => probe.status === "invalid")) {
      return { status: "undeliverable", email: null, confidence: 96, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: null, patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "All tested patterns were rejected by the mail server.", checkedAt: new Date().toISOString(), probes: result.probes };
    }
    return { status: "risky", email: null, confidence: 0, domain, mxHost: mx.host, provider: mx.provider, catchAll: false, badge: "SMTP verification inconclusive", patternBadge: null, predictions: [], pattern: null, observedEmails: [], message: "The mail server deferred or refused verification. No candidate was selected.", checkedAt: new Date().toISOString(), probes: result.probes };
  } catch (error) {
    if (isAntiAbuseRejection(error)) {
      return { ...emptyResult(domain, "risky", "The mail gateway rejected the SMTP handshake with an anti-abuse response. No candidate was selected."), mxHost: mx.host, provider: mx.provider, badge: "SMTP policy restricted" };
    }
    if (isPort25Restricted(error)) {
      return { ...emptyResult(domain, "risky", "Outbound SMTP on port 25 is blocked or unavailable. Configure SMTP_WORKER_URL for live verification. No candidate was selected."), mxHost: mx.host, provider: mx.provider, badge: "Port 25 unavailable" };
    }
    return { ...emptyResult(domain, "risky", error instanceof Error ? error.message : "SMTP verification failed."), mxHost: mx.host, provider: mx.provider };
  }
}

export async function verifyDomainAndCandidates(
  name: string,
  rawDomain: string,
  onProgress: (phase: VerificationProgress) => void | Promise<void> = () => undefined,
): Promise<VerificationResult> {
  const result = await verifyDomainAndCandidatesCore(name, rawDomain, onProgress);
  if (result.status === "domain_invalid") return result;

  const [domainRecords, dmarcRecords] = await Promise.all([
    resolveTxt(result.domain).catch(() => []),
    resolveTxt(`_dmarc.${result.domain}`).catch(() => []),
  ]);
  const spf = domainRecords.map((record) => record.join("")).find((record) => /^v=spf1\b/i.test(record)) ?? null;
  const dmarc = dmarcRecords.map((record) => record.join("")).find((record) => /^v=DMARC1\b/i.test(record)) ?? null;
  return { ...result, spf, dmarc };
}