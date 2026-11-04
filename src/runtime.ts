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
    vault = new Vault(
      c.ENCRYPTION_KEY,
      c.ENCRYPTION_KEY_ID,
      JSON.parse(c.ENCRYPTION_PREVIOUS_KEYS),
    );
  const service = new MailService(
    store,
    vault,
    makeFactory(
      store,
      vault,
      {
        outboundProxy: c.OUTBOUND_PROXY_URL || undefined,
        privateEndpoints: c.PRIVATE_ENDPOINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      undefined,
      c.JMAP_ALLOWED_ORIGINS.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      c.EWS_ALLOWED_ORIGINS.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
    c.BASE_URL,
    {
      retention: {
        cacheDays: c.RETENTION_CACHE_DAYS,
        draftDays: c.RETENTION_DRAFT_DAYS,
        auditDays: c.RETENTION_AUDIT_DAYS,
      },
      ocr:
        c.OCR_ENABLED === "true"
          ? { binary: c.OCR_BINARY, languages: c.OCR_LANGUAGES }
          : undefined,
      hostFileOrigins: c.HOST_FILE_ORIGINS.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    },
  );
  return { config: c, db, service };
}
