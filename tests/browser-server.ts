// Local browser fixture only. Never imported by src/ or the production image.
import { mkdirSync, writeFileSync } from "node:fs";
import { fixture, alice } from "./helpers.js";
import { app } from "../src/app.js";
import { widget } from "../src/widget.js";
import { config } from "../src/config.js";
import { opaque, hash } from "../src/crypto.js";
import { MailError } from "../src/domain.js";
const f = await fixture(),
  base = "http://localhost:4379";
f.service.baseUrl = base;
const second = await f.service.connect(
  alice,
  {
    provider: "gmail",
    email: "test@example.com",
    oauth: { accessToken: "lab-only-second" },
  },
  true,
  true,
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
  JSON.stringify({ sid, account: f.account.id, second: second.id }),
  { mode: 0o600 },
);
server.get("/widget-test", async (_req, reply) =>
  reply
    .type("text/html; charset=utf-8")
    .header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' blob:; connect-src 'self'",
    )
    .send(
      `<!doctype html><meta charset="utf-8"><iframe title="AnyMail" id="widget" style="width:100%;height:1600px;border:0"></iframe><script>const frame=document.getElementById('widget');addEventListener('message',async e=>{if(e.source!==frame.contentWindow)return;const m=e.data;if(!m.id)return;try{let result;if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'fixture',version:'1'},hostCapabilities:{serverTools:{},serverResources:{}}};else if(m.method==='tools/call'){const r=await fetch('/api/call/'+m.params.name,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':${JSON.stringify(csrf)}},body:JSON.stringify(m.params.arguments)}),data=await r.json();if(!r.ok)throw Error(data.error);result={structuredContent:Array.isArray(data)?{items:data}:data,content:[]}}else if(m.method==='ui/open-link'){window.lastOpened=m.params.url;result={}}else throw Error('unsupported fixture method');frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},'*')}catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:error.message}},'*')}});frame.srcdoc=${JSON.stringify(widget).replaceAll("<", "\\u003c")};</script>`,
    ),
);
await server.listen({ port: 4379, host: "127.0.0.1" });
console.log("Browser fixture ready (synthetic data, no real providers).");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    await f.close();
    process.exit(0);
  });
