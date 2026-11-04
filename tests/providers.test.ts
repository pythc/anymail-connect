import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import iconv from "iconv-lite";
import { GmailProvider, gmailMessage } from "../src/providers/gmail.js";
import { GraphProvider } from "../src/providers/graph.js";
import { Rest, cursorEncode } from "../src/providers/rest.js";
import { draftSchema } from "../src/domain.js";
import { resolveEndpoint, type HttpRequest } from "../src/network.js";
import { verifier } from "../src/auth.js";
test("provider HTTP contracts and network boundaries", async (t) => {
  const requests: { url: string; options: any }[] = [];
  let respond = (_url: string, _o: any): any => ({});
  const http: HttpRequest = async (url, options) => {
    requests.push({ url, options });
    const r = respond(url, options);
    return {
      status: r.status || 200,
      body: Buffer.from(JSON.stringify(r.status ? (r.body ?? {}) : r)),
      headers: r.headers || {},
    };
  };
  const gmail = new GmailProvider(
    new Rest("https://gmail.googleapis.com/gmail/v1", async () => "test", http),
    "test@example.com",
  );
  const graph = new GraphProvider(
    new Rest("https://graph.microsoft.com/v1.0", async () => "test", http),
    undefined,
    "test@example.com",
  );
  await t.test(
    "public transport denies private/encoded hosts and unapproved ports",
    async () => {
      for (const host of [
        "127.0.0.1",
        "::1",
        "169.254.169.254",
        "::ffff:127.0.0.1",
        "10.0.0.1",
      ])
        await assert.rejects(
          resolveEndpoint(host, 443, { privateEndpoints: [] }),
        );
      await assert.rejects(
        resolveEndpoint("127.0.0.1", 22, { privateEndpoints: [] }),
      );
      await assert.rejects(
        resolveEndpoint("user@host", 443, { privateEndpoints: [] }),
      );
      assert.ok(
        (
          await resolveEndpoint("127.0.0.1", 993, {
            privateEndpoints: ["127.0.0.1:993"],
          })
        ).length,
      );
    },
  );
  await t.test(
    "Graph pagination cannot exfiltrate its bearer token",
    async () => {
      await assert.rejects(
        graph.search({
          query: "",
          limit: 20,
          cursor: cursorEncode({ path: "https://attacker.invalid/messages" }),
        }),
        /INVALID_CURSOR/,
      );
      await assert.rejects(
        graph.search({
          query: "",
          limit: 20,
          cursor: cursorEncode({
            path: "https://graph.microsoft.com/v1.0/me/contacts",
          }),
        }),
        /INVALID_CURSOR/,
      );
    },
  );
  await t.test(
    "OData literal escapes apostrophe; invalid query combination is explicit",
    async () => {
      respond = () => ({ value: [] });
      await graph.search({ query: "", from: "a'b@example.com", limit: 20 });
      assert.match(decodeURIComponent(requests.at(-1)!.url), /a''b/);
      await assert.rejects(
        graph.search({ query: "invoice", unread: true, limit: 20 }),
        /UNSUPPORTED/,
      );
    },
  );
  await t.test(
    "429 preserves retry-after and never returns empty success",
    async () => {
      respond = () => ({ status: 429, headers: { "retry-after": "30" } });
      await assert.rejects(
        gmail.verify(),
        (e: any) => e.code === "RATE_LIMITED" && e.details.retryAfter === "30",
      );
    },
  );
  await t.test(
    "Gmail expired history resets to full sync with a fresh baseline",
    async () => {
      respond = (url) =>
        url.includes("/history?")
          ? { status: 404 }
          : url.endsWith("/profile")
            ? { historyId: "200" }
            : { messages: [] };
      const r = await gmail.sync({ phase: "history", historyId: "old" });
      assert.equal(r.reset, true);
      assert.deepEqual(r.checkpoint, { phase: "history", historyId: "200" });
    },
  );
  await t.test(
    "Graph delta maps deletion tombstones and retains continuation",
    async () => {
      respond = () => ({
        value: [{ id: "deleted", "@removed": { reason: "deleted" } }],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=test",
      });
      const r = await graph.sync(undefined);
      assert.deepEqual(r.deleted, ["deleted"]);
      assert.equal(r.complete, true);
    },
  );
  await t.test(
    "Graph sends MIME including original reply headers and Bcc",
    async () => {
      respond = () => ({ status: 202, body: {} });
      await graph.send(
        draftSchema.parse({
          to: ["to@example.com"],
          bcc: ["hidden@example.com"],
          subject: "reply",
          text: "text",
          inReplyTo: "<original@example.com>",
        }),
        [],
        crypto.randomUUID(),
      );
      const req = requests.at(-1)!;
      assert.equal(req.options.headers["content-type"], "text/plain");
      const mime = Buffer.from(req.options.body, "base64").toString();
      assert.match(mime, /In-Reply-To: <original@example.com>/);
      assert.match(mime, /Bcc: hidden@example.com/);
    },
  );
  await t.test(
    "Gmail maps quoted addresses, Cc, Reply-To and declared non-UTF8 charset",
    () => {
      const m = gmailMessage({
        id: "m",
        payload: {
          mimeType: "text/plain",
          headers: [
            {
              name: "To",
              value: '"Doe, Jane" <jane@example.com>, test@example.com',
            },
            { name: "Cc", value: '"Colleague, One" <cc@example.com>' },
            { name: "Reply-To", value: "replies@example.com" },
            { name: "Content-Type", value: 'text/plain; charset="gbk"' },
          ],
          body: { data: iconv.encode("中文发票", "gbk").toString("base64url") },
        },
      });
      assert.deepEqual(m.to, ["jane@example.com", "test@example.com"]);
      assert.deepEqual(m.cc, ["cc@example.com"]);
      assert.deepEqual(m.replyTo, ["replies@example.com"]);
      assert.equal(m.text, "中文发票");
    },
  );
  await t.test(
    "Gmail HTML-only and separately stored body return full text; inline files stay downloadable",
    async () => {
      const html = "<p>HTML full body beyond snippet</p>";
      respond = (url) =>
        url.includes("/attachments/body-part")
          ? { data: Buffer.from(html).toString("base64url") }
          : {
              id: "mixed",
              snippet: "short",
              payload: {
                mimeType: "multipart/mixed",
                parts: [
                  {
                    partId: "0",
                    mimeType: "text/html",
                    body: { attachmentId: "body-part", size: html.length },
                  },
                  {
                    partId: "1",
                    filename: "note.txt",
                    mimeType: "text/plain",
                    body: {
                      data: Buffer.from("file only").toString("base64url"),
                      size: 9,
                    },
                  },
                ],
              },
            };
      const m = await gmail.get("mixed");
      assert.equal(m.text, "HTML full body beyond snippet");
      assert.equal(m.attachments.length, 1);
      const a = await gmail.attachment("mixed", m.attachments[0]!.id);
      assert.equal(a.content.toString(), "file only");
      assert.equal(a.name, "note.txt");
      await assert.rejects(gmail.attachment("mixed", "foreign"), /NOT_FOUND/);
    },
  );
  await t.test(
    "Gmail attachment references survive changing download IDs and MIME traversal order",
    async () => {
      let reads = 0;
      respond = (url) => {
        if (url.includes("/attachments/"))
          return {
            data: Buffer.from("selected attachment").toString("base64url"),
          };
        reads++;
        const file = {
          partId: "1.2",
          filename: "same-name.txt",
          mimeType: "text/plain",
          body: { attachmentId: `download-${reads}`, size: 19 },
        };
        return {
          id: "rotating",
          payload: {
            partId: "",
            mimeType: "multipart/mixed",
            parts: [
              ...(reads > 1
                ? [{ partId: "0", mimeType: "text/plain", body: {} }]
                : []),
              { partId: "1", mimeType: "multipart/mixed", parts: [file] },
            ],
          },
        };
      };
      const first = await gmail.get("rotating");
      const second = await gmail.get("rotating");
      assert.equal(first.attachments[0]!.id, "part-id:1.2");
      assert.equal(second.attachments[0]!.id, first.attachments[0]!.id);
      const file = await gmail.attachment("rotating", first.attachments[0]!.id);
      assert.equal(file.content.toString(), "selected attachment");
      assert.ok(requests.at(-1)!.url.endsWith("/attachments/download-3"));
      await assert.rejects(
        gmail.attachment("rotating", "part-id:foreign"),
        /NOT_FOUND/,
      );
    },
  );
  await t.test(
    "Gmail empty root part IDs and legacy inline references remain readable",
    async () => {
      respond = () => ({
        id: "root-file",
        payload: {
          partId: "",
          filename: "root.txt",
          mimeType: "text/plain",
          body: {
            data: Buffer.from("root file").toString("base64url"),
            size: 9,
          },
        },
      });
      const message = await gmail.get("root-file");
      assert.equal(message.attachments[0]!.id, "part-id:");
      assert.equal(
        (
          await gmail.attachment("root-file", message.attachments[0]!.id)
        ).content.toString(),
        "root file",
      );
      assert.equal(
        (await gmail.attachment("root-file", "part:0")).content.toString(),
        "root file",
      );
    },
  );
  await t.test(
    "one unknown Gmail charset retains the search page with an explicit warning",
    async () => {
      respond = (url) =>
        url.includes("/messages?")
          ? { messages: [{ id: "unsupported" }, { id: "normal" }] }
          : {
              id: url.includes("unsupported") ? "unsupported" : "normal",
              payload: {
                mimeType: "text/plain",
                headers: [
                  {
                    name: "Content-Type",
                    value: `text/plain; charset=${url.includes("unsupported") ? "x-unknown-label" : "utf-8"}`,
                  },
                ],
                body: {
                  data: Buffer.from("visible mail").toString("base64url"),
                },
              },
            };
      const page = await gmail.search({ query: "", limit: 20 });
      assert.equal(page.items.length, 2);
      assert.match(page.items[0]!.warnings![0]!, /UNSUPPORTED_CHARSET/);
      assert.equal(page.items[1]!.text, "visible mail");
    },
  );
  await t.test(
    "Graph requests internet headers and returns full HTML text beyond preview",
    async () => {
      respond = () => ({
        id: "m",
        bodyPreview: "short preview",
        body: {
          contentType: "html",
          content: "<p>Full body</p><p>tail after preview &amp; text</p>",
        },
        internetMessageHeaders: [
          { name: "List-Unsubscribe", value: "<mailto:leave@example.com>" },
        ],
      });
      const m = await graph.get("m");
      assert.ok(
        new URL(requests.at(-1)!.url).searchParams
          .get("$select")
          ?.includes("internetMessageHeaders"),
      );
      assert.match(m.text, /tail after preview & text/);
      assert.equal(
        m.headers?.["list-unsubscribe"],
        "<mailto:leave@example.com>",
      );
    },
  );
  await t.test(
    "native watch/subscription creation, renewal and cancellation contracts",
    async () => {
      respond = (url) =>
        url.endsWith("/watch")
          ? { expiration: String(Date.now() + 7 * 86400_000), historyId: "100" }
          : { status: 204 };
      const watch = await gmail.subscribe({
        topic: "projects/lab/topics/mail",
      });
      assert.equal(watch.id, "test@example.com");
      assert.equal(
        JSON.parse(requests.at(-1)!.options.body).topicName,
        "projects/lab/topics/mail",
      );
      await gmail.unsubscribe();
      assert.ok(requests.at(-1)!.url.endsWith("/users/me/stop"));
      respond = (_url, o) =>
        o.method === "GET"
          ? { value: [] }
          : {
              id: "subscription-lab",
              expirationDateTime: new Date(
                Date.now() + 2 * 86400_000,
              ).toISOString(),
            };
      const result = await graph.subscribe({
        callback: "https://anymail.invalid/webhooks/graph",
        clientState: "synthetic-secret",
      });
      assert.equal(result.id, "subscription-lab");
      assert.equal(
        JSON.parse(requests.at(-1)!.options.body).includeResourceData,
        undefined,
      );
      assert.equal(
        JSON.parse(requests.at(-1)!.options.body).clientState,
        "synthetic-secret",
      );
      await graph.subscribe({
        callback: "https://anymail.invalid/webhooks/graph",
        clientState: "synthetic-secret",
        id: result.id,
      });
      assert.equal(requests.at(-1)!.options.method, "PATCH");
      respond = () => ({ status: 404 });
      await graph.unsubscribe(result.id);
    },
  );
  await t.test(
    "Gmail raw MIME contains attachment and correct from identity",
    async () => {
      respond = () => ({ id: "accepted" });
      await gmail.send(
        draftSchema.parse({
          to: ["to@example.com"],
          subject: "mail",
          text: "body",
        }),
        [
          {
            filename: "file.txt",
            contentType: "text/plain",
            content: Buffer.from("hello"),
          },
        ],
        crypto.randomUUID(),
      );
      const mime = Buffer.from(
        JSON.parse(requests.at(-1)!.options.body).raw,
        "base64url",
      ).toString();
      assert.match(mime, /From: test@example.com/);
      assert.match(mime, /file.txt/);
    },
  );
});
test("JWT rejects wrong issuer, audience, client, expired or untrusted tenant identity", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    key = await exportJWK(publicKey),
    verify = verifier(
      "https://issuer.invalid",
      "https://anymail.invalid/mcp",
      ["mcp"],
      createLocalJWKSet({ keys: [key] }),
    );
  const sign = (extra = {}) =>
    new SignJWT({
      tenant_id: "enterprise",
      azp: "mcp",
      scope: "mail.read",
      sub: "alice",
      iss: "https://issuer.invalid",
      aud: "https://anymail.invalid/mcp",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...extra,
    })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);
  assert.equal((await verify(await sign())).principal.tenant, "enterprise");
  for (const extra of [
    { aud: "other" },
    { iss: "other" },
    { azp: "untrusted" },
    { exp: 1 },
    { tenant_id: null },
  ])
    await assert.rejects(verify(await sign(extra)));
});
