import type { VerificationResult } from "@/lib/smtp-verifier";

type ProviderResult = { status: string; email?: string; response: string };

function statusFor(value: string): VerificationResult["status"] {
  const normalized = value.toLowerCase();
  if (["ok", "valid", "deliverable"].includes(normalized)) return "deliverable";
  if (["catch_all", "accept_all", "accept-all"].includes(normalized)) return "catch_all";
  if (["invalid", "undeliverable", "unknown_email"].includes(normalized)) return "undeliverable";
  return "risky";
}

async function checkCandidate(provider: string, apiKey: string, email: string): Promise<ProviderResult> {
  const signal = AbortSignal.timeout(8000);
  if (provider === "millionverifier") {
    const url = new URL("https://api.millionverifier.com/api/v3/");
    url.searchParams.set("api", apiKey);
    url.searchParams.set("email", email);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`MillionVerifier returned HTTP ${response.status}.`);
    const body = await response.json() as { result?: string; status?: string };
    return { status: body.result || body.status || "unknown", email, response: "Provider verification" };
  }

  if (provider === "zerobounce") {
    const url = new URL("https://api.zerobounce.net/v2/validate");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("email", email);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`ZeroBounce returned HTTP ${response.status}.`);
    const body = await response.json() as { status?: string; sub_status?: string };
    return { status: body.sub_status === "accept_all" ? "catch_all" : body.status || "unknown", email, response: "Provider verification" };
  }

  const url = new URL("https://api.hunter.io/v2/email-verifier");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("email", email);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Hunter returned HTTP ${response.status}.`);
  const body = await response.json() as { data?: { status?: string; score?: number; accept_all?: boolean } };
  return { status: body.data?.accept_all ? "catch_all" : body.data?.status || "unknown", email, response: `Provider score ${body.data?.score ?? "unavailable"}` };
}

export async function verifyWithProvider(
  base: VerificationResult,
  candidates: string[],
): Promise<VerificationResult | null> {
  const provider = (process.env.FALLBACK_PROVIDER || "").toLowerCase();
  const envKey = provider === "millionverifier" ? "MILLIONVERIFIER_API_KEY" : provider === "zerobounce" ? "ZEROBOUNCE_API_KEY" : provider === "hunter" ? "HUNTER_API_KEY" : "";
  const apiKey = envKey ? process.env[envKey] : undefined;
  if (!provider || !apiKey) return null;

  const probes: VerificationResult["probes"] = [];
  for (const email of candidates) {
    const checked = await checkCandidate(provider, apiKey, email);
    const status = statusFor(checked.status);
    probes.push({ email, code: status === "deliverable" ? 200 : status === "undeliverable" ? 550 : status === "catch_all" ? 250 : null, message: checked.response, status: status === "deliverable" ? "deliverable" : status === "undeliverable" ? "invalid" : status === "catch_all" ? "catch_all" : "risky" });
    if (status === "deliverable" || status === "catch_all") {
      return {
        ...base,
        status,
        email: status === "catch_all" ? null : email,
        confidence: status === "deliverable" ? 94 : 64,
        catchAll: status === "catch_all",
        badge: status === "catch_all"
          ? base.provider === "Custom mail server" ? "Catch-all / Predicted Pattern" : "Enterprise Protected / Predicted Pattern"
          : null,
        patternBadge: null,
        predictions: [],
        message: `${provider} reported ${status.replace("_", " ")}.`,
        probes,
      };
    }
  }

  if (probes.length === candidates.length && probes.every((probe) => probe.code === 550)) {
    return { ...base, status: "undeliverable", confidence: 91, catchAll: false, badge: null, predictions: [], email: null, message: `${provider} rejected all tested patterns.`, probes };
  }
  return {
    ...base,
    status: "risky",
    email: null,
    confidence: 0,
    badge: "Verification inconclusive",
    predictions: [],
    message: `${provider} could not confirm a recipient. No candidate was selected.`,
    probes,
  };
}