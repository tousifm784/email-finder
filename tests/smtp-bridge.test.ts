import assert from "node:assert/strict";
import test from "node:test";
import { verifyWithRemoteWorker } from "../lib/smtp-verifier";

test("sends candidates to the remote worker and ignores unsubmitted addresses", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SMTP_WORKER_URL;
  const originalToken = process.env.SMTP_WORKER_TOKEN;
  process.env.SMTP_WORKER_URL = "https://worker.example.test/verify";
  process.env.SMTP_WORKER_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), process.env.SMTP_WORKER_URL);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      domain: "example.com",
      mxHost: "mx.example.com",
      candidates: ["alex.morgan@example.com"],
    });
    return Response.json({
      catchAll: false,
      probes: [
        { email: "alex.morgan@example.com", code: 250, message: "Recipient accepted" },
        { email: "admin@example.com", code: 250, message: "Unrequested result" },
      ],
    });
  };

  try {
    const result = await verifyWithRemoteWorker("mx.example.com", "example.com", ["alex.morgan@example.com"]);
    assert.deepEqual(result, {
      catchAll: false,
      probes: [{ email: "alex.morgan@example.com", code: 250, message: "Recipient accepted" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SMTP_WORKER_URL;
    else process.env.SMTP_WORKER_URL = originalUrl;
    if (originalToken === undefined) delete process.env.SMTP_WORKER_TOKEN;
    else process.env.SMTP_WORKER_TOKEN = originalToken;
  }
});