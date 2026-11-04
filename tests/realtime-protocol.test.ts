import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { ImapProvider } from "../src/providers/imap.js";
import { draftSchema } from "../src/domain.js";
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(20);
  }
  throw Error("Protocol event timeout");
}
async function lab(starttls: boolean) {
  const key = readFileSync(".test-certs/server.key"),
    cert = readFileSync(".test-certs/ca.crt");
  const imap = imapkit({
    secureConnection: false,
    credentials: { key, cert },
    plugins: ["AUTH=PLAIN", "IDLE", ...(starttls ? ["STARTTLS"] : [])],
    storage: { INBOX: { messages: [] } },
  });
  const logins: boolean[] = [];
  imap.on("session", (e: any) => {
    if (e.type === "login") logins.push(e.session.secure);
  });
  const port = await imap.start(0, "127.0.0.1");
  const auth: boolean[] = [];
  let delivered = 0;
  const smtp = new SMTPServer({
    secure: false,
    key,
    cert,
    allowInsecureAuth: true,
    disabledCommands: starttls ? [] : ["STARTTLS"],
    onAuth(a, s, cb) {
      auth.push(s.secure);
      cb(null, { user: a.username });
    },
    onData(stream, _s, cb) {
      stream.resume();
      stream.on("end", () => {
        delivered++;
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const smtpPort = (smtp.server.address() as import("node:net").AddressInfo)
    .port;
  const provider = new ImapProvider(
    {
      provider: "imap",
      email: "test@example.com",
      username: "testuser",
      password: "testpass",
      imap: { host: "127.0.0.1", port, secure: false },
      smtp: { host: "127.0.0.1", port: smtpPort, secure: false },
      saveSentCopy: false,
    },
    { privateEndpoints: [`127.0.0.1:${port}`, `127.0.0.1:${smtpPort}`] },
  );
  return {
    imap,
    provider,
    logins,
    auth,
    delivered: () => delivered,
    close: async () => {
      await imap.stop();
      await new Promise<void>((r) => smtp.close(r));
    },
  };
}
test(
  "actual STARTTLS, IDLE and downgrade refusal",
  { timeout: 30_000 },
  async (t) => {
    const l = await lab(true);
    t.after(l.close);
    await t.test(
      "both protocols upgrade before credentials or message bytes",
      async () => {
        await l.provider.verify();
        await l.provider.send(
          draftSchema.parse({
            to: ["recipient@example.com"],
            subject: "TLS lab",
            text: "synthetic",
          }),
          [],
          crypto.randomUUID(),
        );
        assert.deepEqual(l.logins, [true]);
        assert.deepEqual(l.auth, [true]);
        assert.equal(l.delivered(), 1);
      },
    );
    await t.test(
      "IDLE delivers a real EXISTS change and abort closes the connection",
      async () => {
        const controller = new AbortController();
        let changes = 0,
          waiting = false;
        const listener = (e: any) => {
          if (e.type === "waiting" && e.command === "IDLE") waiting = true;
        };
        l.imap.on("session", listener);
        const watch = l.provider.watch(
          "INBOX",
          () => {
            changes++;
          },
          controller.signal,
        );
        try {
          await until(() => waiting);
          const before = changes;
          l.imap.control.addMessage("INBOX", {
            raw: "Subject: incoming\r\n\r\nSynthetic delivery\r\n",
            flags: [],
          });
          await until(() => changes > before);
        } finally {
          controller.abort();
          await watch;
          l.imap.removeListener("session", listener);
        }
        await until(() => l.imap.control.sessions().length === 0);
      },
    );
    await t.test(
      "missing STARTTLS rejects without exposing credentials or sending",
      async () => {
        const plain = await lab(false);
        try {
          await assert.rejects(plain.provider.verify());
          await assert.rejects(
            plain.provider.send(
              draftSchema.parse({
                to: ["recipient@example.com"],
                subject: "must fail",
                text: "must not send",
              }),
              [],
              crypto.randomUUID(),
            ),
          );
          assert.deepEqual(plain.logins, []);
          assert.deepEqual(plain.auth, []);
          assert.equal(plain.delivered(), 0);
        } finally {
          await plain.close();
        }
      },
    );
  },
);
