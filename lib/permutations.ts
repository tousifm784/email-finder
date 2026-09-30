import { normalizeDomain } from "@/lib/domain";

export type NameParts = {
  first: string;
  last: string;
};

const prefixes = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir"]);
const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md"]);

function cleanToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function parseName(fullName: string): NameParts {
  const tokens = fullName
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((token) => !prefixes.has(token.replace(/\./g, "").toLowerCase()))
    .filter((token) => !suffixes.has(token.replace(/[.,]/g, "").toLowerCase()))
    .map(cleanToken)
    .filter(Boolean);

  if (tokens.length < 2) {
    throw new Error("Enter both a first and last name.");
  }

  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

export function generatePermutations(fullName: string, domain: string): string[] {
  const { first, last } = parseName(fullName);
  const normalizedDomain = normalizeDomain(domain);
  const firstInitial = first[0];
  const localParts = [
    `${first}.${last}`,
    first,
    `${first}${last}`,
    `${firstInitial}${last}`,
    `${first}_${last}`,
    `${first}.${last[0]}`,
    `${firstInitial}.${last}`,
    `${last}.${first}`,
    last,
    `${first}-${last}`,
  ];

  return [...new Set(localParts.map((local) => `${local}@${normalizedDomain}`))];
}