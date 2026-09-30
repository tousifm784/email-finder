import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { runSmtpHandshake, type SmtpTarget } from "../lib/smtp-engine";

async function withFakeSmtp(
  responseForRecipient: (email: string, recipientIndex: number) => number,
  run: (target: SmtpTarget, commands: string[]) => Promise<void>,
): Promise<void> {
  const commands: string[] = [];
  let recipientIndex = 0;
  const server = createServer((socket) => {
    socket.write("220 mx.test ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const command of lines) {
        if (!command) continue;
        commands.push(command);
        if (/^(EHLO|HELO) /.test(command)) socket.write("250-mx.test\r\n250 ready\r\n");
        else if (command.startsWith("MAIL FROM:")) socket.write("250 sender ok\r\n");
        else if (command.startsWith("RCPT TO:")) {
          const email = command.match(/<([^>]+)>/)?.[1] ?? "";
          socket.write(`${responseForRecipient(email, recipientIndex++)} recipient response\r\n`);
        } else if (command === "RSET") socket.write("250 reset\r\n");
        else if (command === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake SMTP server did not bind a TCP port.");

  const originalHelo = process.env.SMTP_HELO_DOMAIN;
  const originalFrom = process.env.SMTP_FROM_ADDRESS;
  const originalTimeout = process.env.SMTP_TIMEOUT_MS;
  process.env.SMTP_HELO_DOMAIN = "mail.verify-service.com";
  process.env.SMTP_FROM_ADDRESS = "check@verify-service.com";
  process.env.SMTP_TIMEOUT_MS = "2000";
  try {
    try {
      await run({ host: "mx.test", address: "127.0.0.1", provider: "Test MX", port: address.port }, commands);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; SMTP commands: ${commands.join(" | ")}`);
    }
  } finally {
    if (originalHelo === undefined) delete process.env.SMTP_HELO_DOMAIN;
    else process.env.SMTP_HELO_DOMAIN = originalHelo;
    if (originalFrom === undefined) delete process.env.SMTP_FROM_ADDRESS;
    else process.env.SMTP_FROM_ADDRESS = originalFrom;
    if (originalTimeout === undefined) delete process.env.SMTP_TIMEOUT_MS;
    else process.env.SMTP_TIMEOUT_MS = originalTimeout;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a 250 catch-all response prevents all candidate RCPT checks", async () => {
  await withFakeSmtp((_email, index) => index === 0 ? 250 : 550, async (target, commands) => {
    const result = await runSmtpHandshake(target, "example.com", ["alex@example.com", "alex.morgan@example.com"]);
    assert.equal(result.catchAll, true);
    assert.equal(result.catchProbe.status, "catch_all");
    assert.deepEqual(result.probes, []);
    assert.equal(commands.filter((command) => command.startsWith("RCPT TO:")).length, 1);
    assert.ok(commands.includes("QUIT"));
  });
});

test("candidate checks continue through invalid responses and stop at the first 250", async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => `candidate${index}@example.com`);
  await withFakeSmtp((_email, index) => [550, 550, 551, 250][index] ?? 550, async (target, commands) => {
    const result = await runSmtpHandshake(target, "example.com", candidates);
    assert.equal(result.catchAll, false);
    assert.deepEqual(result.probes.map(({ email, code, status }) => ({ email, code, status })), [
      { email: candidates[0], code: 550, status: "invalid" },
      { email: candidates[1], code: 551, status: "invalid" },
      { email: candidates[2], code: 250, status: "deliverable" },
    ]);
    assert.equal(commands.filter((command) => command.startsWith("RCPT TO:")).length, 4);
  });
});

test("a greylisted catch-all probe blocks candidate checks", async () => {
  await withFakeSmtp(() => 450, async (target, commands) => {
    const result = await runSmtpHandshake(target, "example.com", ["alex@example.com"]);
    assert.equal(result.catchAll, false);
    assert.equal(result.catchProbe.status, "risky");
    assert.deepEqual(result.probes, []);
    assert.equal(commands.filter((command) => command.startsWith("RCPT TO:")).length, 1);
  });
});