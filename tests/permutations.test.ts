import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDomain } from "../lib/domain";
import { discoverDomainPattern } from "../lib/pattern-discovery";
import { generatePermutations, parseName } from "../lib/permutations";

test("generates ten enterprise patterns in frequency order", () => {
  assert.deepEqual(generatePermutations("Reid S. Hoffman", "linkedin.com"), [
    "rhoffman@linkedin.com",
    "reid.hoffman@linkedin.com",
    "reid@linkedin.com",
    "reidhoffman@linkedin.com",
    "r.hoffman@linkedin.com",
    "reid_hoffman@linkedin.com",
    "reid.h@linkedin.com",
    "hoffman.reid@linkedin.com",
    "rh@linkedin.com",
    "reid-hoffman@linkedin.com",
  ]);
});

test("normalizes spaced URLs and removes paths from domains", () => {
  assert.equal(normalizeDomain("https:// linkedin.com/people/reid"), "linkedin.com");
  assert.equal(normalizeDomain("  http://linkedin.com/about/  "), "linkedin.com");
});

test("normalizes accents, titles, suffixes, and middle names", () => {
  assert.deepEqual(parseName("Dr. José María O'Connor, Jr."), { first: "jose", last: "oconnor" });
});

test("requires a first and last name", () => {
  assert.throws(() => generatePermutations("Madonna", "example.com"), /first and last name/);
});

test("scores repeated public email structures as a high-confidence pattern", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<p>John Smith john.smith@acme.com Jane Doe jane.doe@acme.com</p>", { status: 200 });
  try {
    const result = await discoverDomainPattern("Alex Morgan", "acme.com", "Custom mail server");
    assert.equal(result.pattern, "first.last");
    assert.equal(result.confidence, 92);
    assert.equal(result.confidenceLabel, "high");
    assert.equal(result.email, "alex.morgan@acme.com");
    assert.equal(result.observedEmails.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses a provider estimate when public search has no matches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("No visible addresses", { status: 200 });
  try {
    const result = await discoverDomainPattern("Alex Morgan", "example.com", "Google Workspace");
    assert.equal(result.pattern, "first.last");
    assert.equal(result.confidence, 65);
    assert.equal(result.confidenceLabel, "estimated");
    assert.equal(result.source, "mx-heuristic");
  } finally {
    globalThis.fetch = originalFetch;
  }
});