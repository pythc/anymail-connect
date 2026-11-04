import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice } from "./helpers.js";
import { app } from "../src/app.js";
import { opaque, hash } from "../src/crypto.js";
import { MailError } from "../src/domain.js";
import { config } from "../src/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("HTTP identity, CSRF, private files and actual MCP transport", async (t) => {
  const f = await fixture();
  const c = config({
    DATABASE_URL: "lab",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BASE_URL: "http://localhost:3000",
    OIDC_ISSUER: "http://localhost:8080/realms/test",
    OIDC_AUDIENCE: "http://localhost:3000/mcp",
    OIDC_CLIENT_ID: "web",
    ALLOWED_CLIENT_IDS: "web,mcp-test",
  });
  const verify = async (token: string) => {
    if (token !== "lab-token") throw new MailError("AUTH_REQUIRED", 401);
    return { principal: alice, expiresAt: Date.now() + 600_000 };
  };
  const server = await app(f.service, c, verify),
    sid = opaque(),
    csrf = opaque(),
    context = "web:" + hash(sid);
  await f.store.setSession(
    context,
    {
      sealed: f.vault.seal(
        { principal: alice, csrf, expiresAt: Date.now() + 600_000 },
        context,
      ),
    },
    new Date(Date.now() + 600_000).toISOString(),
  );
  const headers = { host: "localhost:3000", cookie: `anymail_session=${sid}` };
  t.after(async () => {
    await server.close();
    await f.close();
  });
  await t.test("anonymous MCP returns OAuth challenge", async () => {
    const r = await server.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: c.BASE_URL.slice(7) },
      payload: {},
    });
    assert.equal(r.statusCode, 401);
    assert.match(
      r.headers["www-authenticate"] as string,
      /oauth-protected-resource/,
    );
  });
  await t.test("reject DNS rebinding Host and foreign Origin", async () => {
    assert.equal(
      (await server.inject({ url: "/", headers: { host: "evil.invalid" } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await server.inject({
          url: "/",
          headers: { ...headers, origin: "https://evil.invalid" },
        })
      ).statusCode,
      403,
    );
  });
  await t.test("mutation requires cookie CSRF; read does not", async () => {
    const r = await server.inject({
      method: "POST",
      url: "/api/call/drafts_create",
      headers,
      payload: { account_id: f.account.id, content: f.content },
    });
    assert.equal(r.statusCode, 403);
    const ok = await server.inject({
      method: "POST",
      url: "/api/call/accounts_list",
      headers,
      payload: {},
    });
    assert.equal(ok.statusCode, 200);
  });
  await t.test("MCP bearer cannot bypass browser approval", async () => {
    const d = await f.service.createDraft(alice, f.account.id, f.content),
      op = await f.service.prepare(alice, f.account.id, d.id, 1, "browser");
    const r = await server.inject({
      method: "POST",
      url: `/approve/${op.id}`,
      headers: { host: "localhost:3000", authorization: "Bearer lab-token" },
      payload: { csrf, digest: op.digest },
    });
    assert.equal(r.statusCode, 403);
    const missing = await server.inject({
      method: "POST",
      url: `/approve/${op.id}`,
      headers,
      payload: { csrf: "wrong", digest: op.digest },
    });
    assert.equal(missing.statusCode, 403);
    const approved = await server.inject({
      method: "POST",
      url: `/approve/${op.id}`,
      headers,
      payload: { csrf, digest: op.digest },
    });
    assert.equal(approved.statusCode, 200);
  });
  await t.test(
    "private attachment endpoint requires authorization",
    async () => {
      const r = await server.inject({
        url: `/api/attachments/${f.account.id}/m1/a`,
        headers: { host: "localhost:3000" },
      });
      assert.equal(r.statusCode, 401);
    },
  );
  await t.test(
    "UI has external scripts, CSP and no HTML interpolation from emails",
    async () => {
      const r = await server.inject({ url: "/", headers });
      assert.equal(r.statusCode, 200);
      assert.match(
        r.headers["content-security-policy"] as string,
        /frame-ancestors 'none'/,
      );
      assert.match(r.body, /app.js/);
    },
  );
  await t.test(
    "real SDK client initializes and calls scoped tools over HTTP",
    async () => {
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      c.BASE_URL = address;
      f.service.baseUrl = address;
      const transport = new StreamableHTTPClientTransport(
        new URL(address + "/mcp"),
        { requestInit: { headers: { authorization: "Bearer lab-token" } } },
      );
      const client = new Client({ name: "anymail-test-client", version: "1" });
      try {
        await client.connect(transport);
        const list = await client.listTools();
        assert.ok(list.tools.some((x) => x.name === "search"));
        assert.ok(!list.tools.some((x) => /approve/.test(x.name)));
        const r = await client.callTool({
          name: "accounts_list",
          arguments: {},
        });
        assert.ok(JSON.stringify(r).includes(f.account.id));
        assert.ok(!JSON.stringify(r).includes("lab-access-token"));
        const imported = list.tools.find(
          (x) => x.name === "attachments_import_file",
        )!;
        assert.deepEqual(imported._meta?.["openai/fileParams"], ["file"]);
        const exported = await client.callTool({
          name: "attachments_export",
          arguments: {
            account_id: f.account.id,
            message_id: "m1",
            attachment_id: "part:/ ü",
          },
        });
        const link = (exported.content as any[]).find(
          (x: any) => x.type === "resource_link",
        ) as any;
        assert.ok(link?.uri.startsWith("anymail://attachment/"));
        const file = await client.readResource({ uri: link.uri });
        assert.equal(
          Buffer.from((file.contents[0] as any).blob, "base64").toString(),
          "test",
        );
        const ui = await client.readResource({ uri: "ui://anymail/preview" });
        assert.match(
          (ui.contents[0] as any).text,
          /ui\/notifications\/initialized/,
        );
        assert.match((ui.contents[0] as any).text, /收件人/);
      } finally {
        await client.close();
      }
    },
  );
});
