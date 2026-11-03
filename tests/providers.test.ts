import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { GmailProvider } from "../src/providers/gmail.js";
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
      body: Buffer.from(JSON.stringify(r.body || r)),
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
