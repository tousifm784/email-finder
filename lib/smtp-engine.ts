import { lookup, resolveMx } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { isIP, Socket } from "node:net";

export type SmtpProbeStatus = "deliverable" | "invalid" | "risky" | "catch_all" | "unknown";
export type SmtpProbe = { email: string; code: number | null; message: string; status?: SmtpProbeStatus };
export type SmtpTarget = { host: string; address: string; provider: string; port?: number };

type SmtpResponse = { code: number; message: string };

export function classifySmtpResponse(code: number | null): SmtpProbeStatus {
  if (code === 250) return "deliverable";
  if (code === 550 || code === 551 || code === 553) return "invalid";
  if (code === 421 || code === 450 || code === 451 || code === null) return "risky";
  return "unknown";
}

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

export async function resolvePublicMxHost(domain: string): Promise<SmtpTarget> {
  const records = await resolveMx(domain);
  if (!records.length || records.every(({ exchange }) => !exchange || exchange === ".")) {
    throw new Error("No MX records found for this domain.");
  }
  records.sort((left, right) => left.priority - right.priority);
  for (const record of records) {
    const addresses = await lookup(record.exchange, { all: true }).catch(() => []);
    const publicAddress = addresses.find(({ address }) => isPublicAddress(address))?.address;
    if (publicAddress) {
      const host = record.exchange.replace(/\.$/, "");
      const value = host.toLowerCase();
      const provider = domain === "linkedin.com" || domain.endsWith(".linkedin.com") || value.includes("linkedin") ? "LinkedIn Enterprise Gateway"
        : value.includes("google") || value.includes("googlemail") ? "Google Workspace"
        : value.includes("outlook") || value.includes("protection.outlook") ? "Microsoft 365"
          : value.includes("proofpoint") || value.includes("pphosted") || value.includes("ppe-hosted") ? "Proofpoint"
          : value.includes("mimecast") ? "Mimecast" : value.includes("zoho") ? "Zoho Mail" : "Custom mail server";
      return { host, address: publicAddress, provider };
    }
  }
  throw new Error("The domain's mail servers did not resolve to public IP addresses.");
}

class SmtpSession {
  private buffer = "";
  private lines: string[] = [];
  private responses: SmtpResponse[] = [];
  private waiters: Array<{ resolve: (response: SmtpResponse) => void; reject: (error: Error) => void }> = [];

  constructor(private readonly socket: Socket, timeoutMs: number) {
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("timeout", () => this.rejectAll(new Error("SMTP connection timed out.")));
    socket.on("close", () => this.rejectAll(new Error("SMTP connection closed.")));
  }

  read(): Promise<SmtpResponse> {
    const response = this.responses.shift();
    if (response) return Promise.resolve(response);
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
        const response = { code: Number(line.slice(0, 3)), message: this.lines.join(" | ").slice(0, 500) };
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(response);
        else this.responses.push(response);
      }
    }
  }

  private rejectAll(error: Error): void {
    while (this.waiters.length) this.waiters.shift()?.reject(error);
  }
}

export async function runSmtpHandshake(
  target: SmtpTarget,
  domain: string,
  candidates: string[],
  onCatchAllProbe: () => void | Promise<void> = () => undefined,
): Promise<{ catchAll: boolean; catchProbe: SmtpProbe; probes: SmtpProbe[] }> {
  const timeoutMs = Math.min(Math.max(Number(process.env.SMTP_TIMEOUT_MS) || 5000, 1000), 5000);
  const heloDomain = process.env.SMTP_HELO_DOMAIN || "mail.verify-service.com";
  const fromAddress = process.env.SMTP_FROM_ADDRESS || "check@verify-service.com";
  const senderDomain = fromAddress.split("@")[1]?.toLowerCase();
  const heloMailDomain = heloDomain.toLowerCase().replace(/^mail\./, "");
  if (!senderDomain || (senderDomain !== heloDomain.toLowerCase() && senderDomain !== heloMailDomain)) {
    throw new Error("SMTP_FROM_ADDRESS must use the configured SMTP_HELO_DOMAIN.");
  }

  const socket = new Socket();
  socket.setTimeout(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("timeout", onTimeout);
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => {
      socket.off("error", onError);
      socket.destroy();
      reject(new Error("SMTP connection timed out."));
    };
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.connect(target.port ?? 25, target.address, () => {
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
    if (response.code !== 250) response = await session.command(`HELO ${heloDomain}`);
    if (response.code !== 250) throw new Error(`SMTP greeting rejected (${response.code}).`);

    response = await session.command(`MAIL FROM:<${fromAddress}>`);
    if (response.code !== 250) throw new Error(`Sender rejected (${response.code}).`);

    await onCatchAllProbe();
    const catchProbeAddress = `catchall_probe_${randomUUID().replaceAll("-", "")}@${domain}`;
    const catchResponse = await session.command(`RCPT TO:<${catchProbeAddress}>`);
    const catchAll = catchResponse.code === 250;
    const catchProbe: SmtpProbe = {
      email: catchProbeAddress,
      code: catchResponse.code,
      message: catchResponse.message,
      status: catchAll ? "catch_all" : classifySmtpResponse(catchResponse.code),
    };
    await session.command("RSET");

    const probes: SmtpProbe[] = [];
    if (!catchAll && [550, 551, 553].includes(catchResponse.code)) {
      for (const email of candidates) {
        const sender = await session.command(`MAIL FROM:<${fromAddress}>`);
        if (sender.code !== 250) {
          probes.push({ email, code: sender.code, message: sender.message, status: "risky" });
          break;
        }

        const candidateResponse = await session.command(`RCPT TO:<${email}>`);
        const status = classifySmtpResponse(candidateResponse.code);
        probes.push({ email, code: candidateResponse.code, message: candidateResponse.message, status });
        await session.command("RSET");
        if (status !== "invalid") break;
      }
    }

    return { catchAll, catchProbe, probes };
  } finally {
    await session.command("QUIT").catch(() => undefined);
    session.end();
  }
}