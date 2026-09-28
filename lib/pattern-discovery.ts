import { normalizeDomain } from "@/lib/domain";
import { parseName } from "@/lib/permutations";

export type EmailPattern = "first.last" | "f.last" | "flast" | "first";

export type PatternDiscovery = {
  pattern: EmailPattern;
  confidence: number;
  confidenceLabel: "high" | "estimated";
  observedEmails: string[];
  source: "public-search" | "mx-heuristic";
  formula: string;
  email: string;
};

const patternOrder: EmailPattern[] = ["f.last", "flast", "first.last", "first"];
const emailRegex = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function decodeHtml(value: string): string {
  return value
    .replace(/&commat;|&#64;|&#x40;/gi, "@")
    .replace(/&period;|&#46;|&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]*>/g, " ");
}

function patternForAddress(email: string, context: string): EmailPattern | null {
  const local = email.split("@")[0].toLowerCase();
  if (/^[a-z]\.[a-z][a-z-]+$/.test(local)) return "f.last";
  if (/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(local)) return "first.last";
  if (/^[a-z][a-z0-9_-]*$/.test(local) && local.length <= 16) {
    const nearbyNames = context.match(/[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)?(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)?/g) ?? [];
    for (const candidate of nearbyNames) {
      try {
        const { first, last } = parseName(candidate);
        if (local === `${first[0]}${last}`) return "flast";
        if (local === first) return "first";
      } catch {
        continue;
      }
    }
    return "first";
  }
  return null;
}

function addressForPattern(name: string, domain: string, pattern: EmailPattern): string {
  const { first, last } = parseName(name);
  const local = {
    "first.last": `${first}.${last}`,
    "f.last": `${first[0]}.${last}`,
    flast: `${first[0]}${last}`,
    first,
  }[pattern];
  return `${local}@${domain}`;
}

function heuristicForProvider(provider: string): EmailPattern {
  const value = provider.toLowerCase();
  if (value.includes("google") || value.includes("microsoft") || value.includes("linkedin")) return "first.last";
  return "f.last";
}

export async function discoverDomainPattern(
  name: string,
  rawDomain: string,
  provider: string,
): Promise<PatternDiscovery> {
  const domain = normalizeDomain(rawDomain);
  const counts = new Map<EmailPattern, Set<string>>(patternOrder.map((pattern) => [pattern, new Set()]));
  const queries = [`site:${domain} "@${domain}"`, `"@${domain}" contact email`];
  const endpoint = process.env.SEARCH_ENGINE_URL || "https://html.duckduckgo.com/html/";

  await Promise.all(queries.map(async (query) => {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      const response = await fetch(url, {
        headers: { "user-agent": "SignalEmailFinder/1.0 (+contact: admin@example.com)", accept: "text/html" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const html = decodeHtml((await response.text()).slice(0, 1_000_000));
      for (const match of html.matchAll(emailRegex)) {
        const email = match[0];
        const normalized = email.toLowerCase().replace(/[.,;:]+$/, "");
        if (!normalized.endsWith(`@${domain}`)) continue;
        const index = match.index ?? 0;
        const context = html.slice(Math.max(0, index - 240), index);
        const pattern = patternForAddress(normalized, context);
        if (pattern) counts.get(pattern)?.add(normalized);
      }
    } catch {
      // Public search is best-effort; provider heuristics remain available offline.
    }
  }));

  const matched = patternOrder
    .map((pattern) => ({ pattern, observedEmails: [...(counts.get(pattern) ?? [])] }))
    .filter((entry) => entry.observedEmails.length >= 2)
    .sort((left, right) => right.observedEmails.length - left.observedEmails.length || patternOrder.indexOf(left.pattern) - patternOrder.indexOf(right.pattern))[0];

  const pattern = matched?.pattern ?? heuristicForProvider(provider);
  const observedEmails = matched?.observedEmails ?? [];
  const format = pattern === "first.last" ? "{first}.{last}" : pattern === "f.last" ? "{f}.{last}" : pattern === "flast" ? "{f}{last}" : "{first}";
  return {
    pattern,
    confidence: matched ? Math.min(98, 92 + Math.max(0, matched.observedEmails.length - 2)) : 65,
    confidenceLabel: matched ? "high" : "estimated",
    observedEmails,
    source: matched ? "public-search" : "mx-heuristic",
    formula: `${format}@${domain}`,
    email: addressForPattern(name, domain, pattern),
  };
}