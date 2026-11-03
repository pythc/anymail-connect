import { runtime } from "./runtime.js";
import { setTimeout } from "node:timers/promises";
import { Synchronizer } from "./sync.js";
const r = await runtime();
let stopping = false;
let lastSync = 0;
let afterAccount = "00000000-0000-0000-0000-000000000000";
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await r.service.tick();
    if (Date.now() - lastSync > 60_000) {
      lastSync = Date.now();
      const rows = await r.db.query<{ data: import("./domain.js").Account }>(
        "SELECT data FROM accounts WHERE data->>'revoked'='false' AND data->>'verified'='true' AND id>$1 ORDER BY id LIMIT 100",
        [afterAccount],
      );
      afterAccount =
        rows.rows.at(-1)?.data.id || "00000000-0000-0000-0000-000000000000";
      for (const { data: a } of rows.rows) {
        if (stopping) break;
        try {
          await new Synchronizer(r.service).run(
            {
              tenant: a.tenant,
              subject: a.owner,
              client: "worker",
              scopes: ["mail.read"],
            },
            a.id,
          );
        } catch {
          console.error(
            "Mailbox sync deferred; inspect authenticated account checkpoints",
          );
        }
      }
    }
  } catch {
    console.error("Worker cycle failed; persisted operations retained");
  }
  if (!stopping) await setTimeout(5000);
}
await r.db.close();
