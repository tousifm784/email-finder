import { normalizeDomain } from "@/lib/domain";
import { parseName } from "@/lib/permutations";
import companyIntelligenceJson from "@/data/company-intelligence.json";
import domainPatterns from "@/data/domain-patterns.json";

export type EmailPattern = "first.last" | "first" | "firstlast" | "flast" | "first_last" | "first.l" | "f.last" | "last.first" | "last" | "first-last";
type CompanyIntelligence = {
  executives: Record<string, string>;
  domains: Record<string, { primary_pattern: string; secondary_pattern?: string; confidence: number }>;
};

export type PatternDiscovery = {
  pattern: string;
  confidence: number;
  confidenceLabel: "high" | "estimated";
  observedEmails: string[];
  source: "executive-record" | "company-formula" | "public-search" | "mx-heuristic";
  formula: string;
  email: string;
  alternates: string[];
};

const companyIntelligence = companyIntelligenceJson as CompanyIntelligence;
const patternOrder: EmailPattern[] = ["first.last", "first", "firstlast", "flast", "first_last", "first.l", "f.last", "last.first", "last", "first-last"];
const emailRegex = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const formulaPatterns: Record<string, string> = {
  "{first}.{last}": "first.last", "{first}": "first", "{first}{last}": "firstlast",
  "{f}{last}": "flast", "{first}_{last}": "first_last", "{first}.{l}": "first.l",
  "{f}.{last}": "f.last", "{last}.{first}": "last.first", "{last}": "last",
  "{first}-{last}": "first-last", "{first}{l}": "first plus last initial",
};

function expandFormula(formula: string, first: string, last: string): string {
  const values: Record<string, string> = {
    first,
    last,
    f: first[0],
    l: last[0],
  };
  return formula.replace(/\{(first|last|f|l)\}/g, (_match, token: string) => values[token] ?? "");
}

export function discoverKnownPattern(name: string, rawDomain: string): PatternDiscovery | null {
  const domain = normalizeDomain(rawDomain);
  const { first, last } = parseName(name);
  const executiveKey = `${first} ${last}@${domain}`;
  const executiveEmail = companyIntelligence.executives[executiveKey];
  const domainFormula = companyIntelligence.domains[domain];
  if (!executiveEmail && !domainFormula) return null;

  const primaryFormula = domainFormula?.primary_pattern ?? "{first}.{last}";
  const secondaryFormula = domainFormula?.secondary_pattern;
  const primaryEmail = `${expandFormula(primaryFormula, first, last)}@${domain}`;
  const secondaryEmail = secondaryFormula ? `${expandFormula(secondaryFormula, first, last)}@${domain}` : null;
  const email = executiveEmail ?? primaryEmail;
  const matchedFormula = email === primaryEmail ? primaryFormula : email === secondaryEmail ? secondaryFormula : null;
  const formulas = [primaryFormula, secondaryFormula].filter((formula): formula is string => Boolean(formula));
  const alternates = [...new Set([
    ...(matchedFormula === primaryFormula && secondaryEmail ? [secondaryEmail] : []),
    ...(matchedFormula === secondaryFormula ? [primaryEmail] : []),
  ])];

  return {
    pattern: matchedFormula ? formulaPatterns[matchedFormula] ?? matchedFormula : "executive record",
    confidence: executiveEmail ? 99 : domainFormula!.confidence,
    confidenceLabel: "high",
    observedEmails: executiveEmail ? [executiveEmail] : [],
    source: executiveEmail ? "executive-record" : "company-formula",
    formula: matchedFormula ? `${matchedFormula}@${domain}` : `executive record: ${email}`,
    email,
    alternates,
  };
}

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
    first: first,
    firstlast: `${first}${last}`,
    flast: `${first[0]}${last}`,
    first_last: `${first}_${last}`,
    "first.l": `${first}.${last[0]}`,
    "f.last": `${first[0]}.${last}`,
    "last.first": `${last}.${first}`,
    last,
    "first-last": `${first}-${last}`,
  }[pattern];
  return `${local}@${domain}`;
}

function heuristicForProvider(provider: string): { pattern: EmailPattern; confidence: number } {
  const value = provider.toLowerCase();
  const match = domainPatterns.find((entry) => entry.provider !== "*" && value.includes(entry.provider.toLowerCase())) ?? domainPatterns.find((entry) => entry.provider === "*");
  return { pattern: (match?.pattern ?? "f.last") as EmailPattern, confidence: match?.confidence ?? 65 };
}

export async function discoverDomainPattern(
  name: string,
  rawDomain: string,
  provider: string,
): Promise<PatternDiscovery> {
  const domain = normalizeDomain(rawDomain);
  const known = discoverKnownPattern(name, domain);
  if (known) return known;
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

  const heuristic = matched ? null : heuristicForProvider(provider);
  const pattern = matched?.pattern ?? heuristic?.pattern ?? "f.last";
  const observedEmails = matched?.observedEmails ?? [];
  const format: Record<EmailPattern, string> = {
    "first.last": "{first}.{last}", first: "{first}", firstlast: "{first}{last}", flast: "{f}{last}",
    first_last: "{first}_{last}", "first.l": "{first}.{l}", "f.last": "{f}.{last}",
    "last.first": "{last}.{first}", last: "{last}", "first-last": "{first}-{last}",
  };
  return {
    pattern,
    confidence: matched ? Math.min(98, 92 + Math.max(0, matched.observedEmails.length - 2)) : heuristic?.confidence ?? 65,
    confidenceLabel: matched ? "high" : "estimated",
    observedEmails,
    source: matched ? "public-search" : "mx-heuristic",
    formula: `${format[pattern]}@${domain}`,
    email: addressForPattern(name, domain, pattern),
    alternates: [],
  };
}