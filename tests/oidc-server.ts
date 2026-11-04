// Opt-in local Keycloak fixture. No pre-created browser session or JWT bypass.
import { fixture } from "./helpers.js";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { authentication } from "../src/auth.js";
const f = await fixture();
const c = config({
  DATABASE_URL: "fixture",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  BASE_URL: "http://localhost:4390",
  OIDC_ISSUER: "http://localhost:4391/realms/anymail",
  OIDC_AUDIENCE: "http://localhost:4390/mcp",
  OIDC_INTROSPECTION: "true",
  OIDC_CLIENT_ID: "anymail-web",
  OIDC_CLIENT_SECRET: "local-oidc-lab-only",
  ALLOWED_CLIENT_IDS: "anymail-web,anymail-chatgpt",
});
f.service.baseUrl = c.BASE_URL;
const auth = await authentication(c);
const server = await app(f.service, c, auth.verify, auth.settings);
await server.listen({ port: 4390, host: "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    await f.close();
    process.exit(0);
  });
