import { runtime } from "./runtime.js";
import { setTimeout } from "node:timers/promises";
import { Synchronizer } from "./sync.js";
import { IdlePool } from "./idle.js";
import { ChangeQueue } from "./change-queue.js";
import { PushService } from "./push.js";
const r = await runtime();
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => controller.abort());
const queue = new ChangeQueue(r.service),
  idle = new IdlePool(r.service, r.config.IMAP_IDLE_CONNECTIONS, queue),
  push = new PushService(r.service, r.config);
idle.start();
controller.signal.addEventListener(
  "abort",
  () => {
    void idle.close();
  },
  { once: true },
);
async function repeat(task: () => Promise<unknown>, ms: number) {
  while (!controller.signal.aborted) {
    try {
      await task();
    } catch {
      console.error("Worker cycle deferred; durable state retained");
    }
    await setTimeout(ms, undefined, { signal: controller.signal }).catch(
      () => {},
    );
  }
}
let afterAccount = "00000000-0000-0000-0000-000000000000";
async function reconcile() {
  const rows = await r.db.query<{ data: import("./domain.js").Account }>(
    "SELECT data FROM accounts WHERE data->>'revoked'='false' AND data->>'verified'='true' AND id>$1 ORDER BY id LIMIT 100",
    [afterAccount],
  );
  afterAccount =
    rows.rows.at(-1)?.data.id ?? "00000000-0000-0000-0000-000000000000";
  for (const { data: a } of rows.rows) {
    if (controller.signal.aborted) break;
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
      console.error("Mailbox reconciliation deferred");
    }
  }
}
// Keep slow delivery/reconciliation from blocking notification ingestion or IDLE leases.
await Promise.all([
  repeat(() => r.service.tick(controller.signal), 5000),
  repeat(() => queue.drain(8, controller.signal), 1000),
  repeat(() => push.renew(controller.signal), 60_000),
  repeat(reconcile, 60_000),
]);
await idle.close();
await r.db.close();
