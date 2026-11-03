import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import imapkit from "imapkit";
import { SMTPServer } from "smtp-server";
import { ImapProvider } from "../src/providers/imap.js";
import { draftSchema } from "../src/domain.js";
test("actual TLS IMAP and SMTP protocol laboratory", async (t) => {
  const key = readFileSync(".test-certs/server.key"),
    cert = readFileSync(".test-certs/ca.crt");
  const imap = imapkit({
    secureConnection: true,
    credentials: { key, cert },
    plugins: ["ID", "MOVE", "UIDPLUS", "SPECIAL-USE", "AUTH=PLAIN"],
    storage: {
      INBOX: {
        messages: [
          {
            raw: "From: sender@example.com\r\nTo: test@example.com\r\nSubject: protocol fixture\r\nMessage-ID: <fixture@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody test\r\n",
            flags: [],
          },
        ],
      },
      "": {
        folders: {
          Trash: { "special-use": "\\Trash" },
          Sent: { "special-use": "\\Sent" },
        },
      },
    },
  });
  const port = await imap.start(0, "127.0.0.1");
  let received = 0,
    delivered = "",
    recipients: string[] = [];
  const smtp = new SMTPServer({
    secure: true,
    key,
    cert,
    authOptional: false,
    onAuth(auth: any, _session: any, callback: any) {
      callback(null, { user: auth.username });
    },
    onData(stream: any, session: any, callback: any) {
      const chunks: Buffer[] = [];
      stream.on("data", (b: Buffer) => chunks.push(b));
      stream.on("end", () => {
        received++;
        delivered = Buffer.concat(chunks).toString();
        recipients = session.envelope.rcptTo.map((r: any) => r.address);
        callback();
      });
    },
  });
  smtp.on("error", () => {});
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const smtpPort = (smtp.server.address() as import("node:net").AddressInfo)
    .port;
  const p = new ImapProvider(
    {
      provider: "imap",
      email: "test@example.com",
      username: "testuser",
      password: "testpass",
      imap: { host: "localhost", port, secure: true },
      smtp: { host: "localhost", port: smtpPort, secure: true },
      saveSentCopy: true,
    },
    { privateEndpoints: [`localhost:${port}`, `localhost:${smtpPort}`] },
  );
  t.after(async () => {
    await imap.stop();
    await new Promise<void>((resolve) => smtp.close(resolve));
  });
  await t.test(
    "TLS login, header search and BODY.PEEK preserve unread state",
    async () => {
      await p.verify();
      const page = await p.search({ query: "", limit: 20 });
      assert.equal(page.items.length, 1);
      const m = await p.get(page.items[0]!.id);
      assert.match(m.text, /Body test/);
      assert.equal(m.read, false);
      assert.equal((await p.get(m.id)).read, false);
    },
  );
  await t.test(
    "flag mutation is visible through the real protocol",
    async () => {
      const page = await p.search({ query: "", limit: 20 });
      await p.mutate(page.items[0]!.id, { action: "read" });
      assert.equal((await p.get(page.items[0]!.id)).read, true);
    },
  );
  await t.test(
    "SMTP MIME keeps threading, Bcc envelope and writes one sent copy",
    async () => {
      const d = draftSchema.parse({
        to: ["to@example.com"],
        bcc: ["hidden@example.com"],
        subject: "测试",
        text: "正文",
        inReplyTo: "<original@example.com>",
      });
      const receipt = await p.send(
        d,
        [
          {
            filename: "账单.txt",
            contentType: "text/plain",
            content: Buffer.from("附件"),
          },
        ],
        crypto.randomUUID(),
      );
      assert.equal(receipt.state, "provider_accepted");
      assert.equal(receipt.sentCopy, "saved");
      assert.equal(received, 1);
      assert.match(delivered, /In-Reply-To: <original@example.com>/);
      const sent = await p.search({ query: "", folder: "Sent", limit: 20 });
      assert.equal(sent.items.length, 1);
    },
  );
  await t.test(
    "SMTP hides Bcc headers while retaining Bcc recipients in envelope",
    () => {
      assert.ok(recipients.includes("hidden@example.com"));
      assert.doesNotMatch(delivered, /^Bcc:/im);
    },
  );
  await t.test(
    "UIDVALIDITY reset refuses stale message instead of reading another UID",
    async () => {
      const page = await p.search({ query: "", limit: 20 });
      imap.control.resetUidValidity("INBOX", { uids: "shuffle", seed: 3 });
      await assert.rejects(p.get(page.items[0]!.id), /STALE_REFERENCE/);
    },
  );
});
