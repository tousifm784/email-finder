import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDomain } from "../lib/domain";
import { discoverDomainPattern, discoverKnownPattern } from "../lib/pattern-discovery";
import { generatePermutations, parseName } from "../lib/permutations";

test("generates ten enterprise patterns in frequency order", () => {
  assert.deepEqual(generatePermutations("Reid S. Hoffman", "linkedin.com"), [
    "reid.hoffman@linkedin.com",
    "reid@linkedin.com",
    "reidhoffman@linkedin.com",
    "rhoffman@linkedin.com",
    "reid_hoffman@linkedin.com",
    "reid.h@linkedin.com",
    "r.hoffman@linkedin.com",
    "hoffman.reid@linkedin.com",
    "hoffman@linkedin.com",
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

test("uses an 85% Microsoft 365 estimate when public search has no matches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("No visible addresses", { status: 200 });
  try {
    const result = await discoverDomainPattern("Alex Morgan", "example.com", "Microsoft 365");
    assert.equal(result.pattern, "first.last");
    assert.equal(result.confidence, 85);
    assert.equal(result.confidenceLabel, "estimated");
    assert.equal(result.source, "mx-heuristic");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefers the executive directory record over public search", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Public search must not be called for a known executive."); };
  try {
    const result = await discoverDomainPattern("Jeff Bezos", "amazon.com", "Custom mail server");
    assert.equal(result.source, "executive-record");
    assert.equal(result.email, "jeff@amazon.com");
    assert.equal(result.confidence, 99);
    assert.equal(result.formula, "{first}@amazon.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the verified company formula before a generic provider estimate", () => {
  const result = discoverKnownPattern("Alex Morgan", "amazon.com");
  assert.equal(result?.source, "company-formula");
  assert.equal(result?.email, "alex@amazon.com");
  assert.equal(result?.confidence, 95);
  assert.deepEqual(result?.alternates, ["amorgan@amazon.com"]);
});

test("uses the curated Microsoft primary and secondary formulas", () => {
  const result = discoverKnownPattern("Alex Morgan", "microsoft.com");
  assert.equal(result?.email, "alex.morgan@microsoft.com");
  assert.equal(result?.alternates[0], "alexm@microsoft.com");
  assert.equal(result?.confidence, 94);
});

test("keeps exceptional executive addresses labeled as directory records", () => {
  const result = discoverKnownPattern("Mark Zuckerberg", "meta.com");
  assert.equal(result?.email, "zuck@meta.com");
  assert.equal(result?.formula, "executive record: zuck@meta.com");
});