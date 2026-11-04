import { config } from "./config.js";
import { postgres, migrate } from "./db.js";
import { Store } from "./store.js";
import { Vault } from "./crypto.js";
import { makeFactory } from "./providers/factory.js";
import { MailService } from "./service.js";
export async function runtime() {
  const c = config(),
    db = postgres(c.DATABASE_URL);
  await migrate(db);
  const store = new Store(db),
    vault = new Vault(c.ENCRYPTION_KEY);
  const service = new MailService(
    store,
    vault,
    makeFactory(
      store,
      vault,
      {
        privateEndpoints: c.PRIVATE_ENDPOINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      undefined,
      c.JMAP_ALLOWED_ORIGINS.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
    c.BASE_URL,
  );
  return { config: c, db, service };
}
