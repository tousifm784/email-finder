import { isIP } from "node:net";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: string): string {
  const candidate = input.trim().replace(/\s+/g, "").toLowerCase();
  let domain: string;
  try {
    if (/^https?:\/\//.test(candidate)) {
      const url = new URL(candidate);
      if (url.username || url.password) throw new Error("Credentials are not allowed in a company URL.");
      domain = url.hostname;
    } else {
      domain = candidate.split(/[/?#]/, 1)[0];
    }
  } catch {
    throw new Error("Enter a valid company domain, such as example.com.");
  }

  if (
    domain.length > 253 ||
    domain.includes(":") ||
    isIP(domain) ||
    domain === "localhost" ||
    domain.split(".").length < 2 ||
    !domain.split(".").every((label) => DOMAIN_LABEL.test(label))
  ) {
    throw new Error("Enter a valid company domain, such as example.com.");
  }
  return domain;
}