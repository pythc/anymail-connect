// Local browser fixture only. Never imported by src/ or the production image.
import { mkdirSync, writeFileSync } from "node:fs";
import { fixture, alice } from "./helpers.js";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { opaque, hash } from "../src/crypto.js";
import { MailError } from "../src/domain.js";
const f = await fixture(),
  base = "http://localhost:4379";
f.service.baseUrl = base;
const upload = await f.service.upload(
  alice,
  f.account.id,
  "invoice<1>.txt",
  "text/plain",
  Buffer.from("synthetic consent fixture"),
);
const draft = await f.service.createDraft(alice, f.account.id, {
  ...f.content,
  bcc: ["synthetic-bcc@example.com"],
  subject: "<script>alert(1)</script>",
  attachmentIds: [upload.id],
});
const operation = await f.service.prepare(
  alice,
  f.account.id,
  draft.id,
  draft.revision,
  "browser",
);
const c = config({
  DATABASE_URL: "test",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  BASE_URL: base,
  OIDC_ISSUER: "http://localhost:8080/realms/test",
  OIDC_AUDIENCE: base + "/mcp",
  OIDC_CLIENT_ID: "web",
  ALLOWED_CLIENT_IDS: "web",
});
const server = await app(f.service, c, async () => {
  throw new MailError("AUTH_REQUIRED", 401);
});
const sid = opaque(),
  context = "web:" + hash(sid),
  csrf = opaque(),
  expiresAt = Date.now() + 600_000;
await f.store.setSession(
  context,
  { sealed: f.vault.seal({ principal: alice, csrf, expiresAt }, context) },
  new Date(expiresAt).toISOString(),
);
mkdirSync(".artifacts", { recursive: true, mode: 0o700 });
writeFileSync(
  ".artifacts/browser-session.json",
  JSON.stringify({ sid, account: f.account.id, operation: operation.id }),
  { mode: 0o600 },
);
// Synthetic session bootstrap for manual browser checks; never a production route.
server.get("/fixture/login", async (_req, reply) =>
  reply
    .setCookie("anymail_session", sid, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    })
    .redirect("/connect"),
);
await server.listen({ port: 4379, host: "127.0.0.1" });
console.log("Browser fixture ready (synthetic data, no real providers).");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    await f.close();
    process.exit(0);
  });
