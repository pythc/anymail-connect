// Separate entrypoint. The normal API and worker never import this module.
import { setTimeout } from "node:timers/promises";
import { config } from "../../src/config.js";
import { postgres, migrate } from "../../src/db.js";
import { Store } from "../../src/store.js";
import { Vault } from "../../src/crypto.js";
import { MailService } from "../../src/service.js";
import { authentication } from "../../src/auth.js";
import { app } from "../../src/app.js";
import { MailError } from "../../src/domain.js";
import { DemoProvider } from "./provider.js";

const c = config();
if (
  c.BASE_URL !== "http://localhost:4480" ||
  c.OIDC_ISSUER !== "http://localhost:4481/realms/anymail-demo" ||
  new URL(c.DATABASE_URL).pathname !== "/anymail_demo" ||
  process.env.NODE_ENV !== "development"
)
  throw Error("Demo requires the isolated loopback configuration");
const db = postgres(c.DATABASE_URL);
try {
  await migrate(db);
  const store = new Store(db),
    vault = new Vault(c.ENCRYPTION_KEY),
    provider = new DemoProvider(),
    principal = {
      tenant: "synthetic-demo",
      subject: "a5a8c029-96a0-4ea7-9449-50178ef90ed1",
      client: "demo-bootstrap",
      scopes: ["mail.read", "mail.write", "mail.send"],
    },
    service = new MailService(
      store,
      vault,
      async (account) => {
        if (
          account.tenant !== principal.tenant ||
          account.owner !== principal.subject ||
          account.email !== "demo@example.test"
        )
          throw new MailError("DEMO_ACCOUNT_ONLY", 403);
        return provider;
      },
      c.BASE_URL,
    );
  if (!(await store.accounts(principal)).some((a) => !a.revoked))
    await service.connect(
      principal,
      {
        // Schema/storage placeholder only; the demo never constructs ImapProvider.
        provider: "imap",
        email: "demo@example.test",
        username: "synthetic",
        password: "not-a-mailbox-credential",
        imap: { host: "invalid.example.test", port: 993, secure: true },
        smtp: { host: "invalid.example.test", port: 465, secure: true },
      },
      true,
      true,
    );
  const auth = await authentication(c),
    server = await app(service, c, auth.verify, auth.settings),
    controller = new AbortController();
  server.addHook("onRequest", async (request) => {
    if (
      ["/api/accounts/connect", "/api/oauth/start"].includes(
        request.url.split("?")[0]!,
      )
    )
      throw new MailError("DEMO_ACCOUNT_ONLY", 403);
  });
  await server.listen({ port: 4480, host: "0.0.0.0" });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => controller.abort());
  console.info("Synthetic demo ready: no real provider or mail delivery");
  while (!controller.signal.aborted) {
    try {
      await service.tick(controller.signal);
    } catch {
      console.error("Demo cycle deferred; persisted state retained");
    }
    await setTimeout(1000, undefined, { signal: controller.signal }).catch(
      () => {},
    );
  }
  await server.close();
} finally {
  await db.close();
}
