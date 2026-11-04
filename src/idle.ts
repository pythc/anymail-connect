import { setTimeout as delay } from "node:timers/promises";
import { opaque } from "./crypto.js";
import type { Account } from "./domain.js";
import type { MailService } from "./service.js";
import { ChangeQueue } from "./change-queue.js";
type Entry = {
  account: Account;
  controller: AbortController;
  token: string;
  opened: number;
  done: Promise<void>;
};
export class IdlePool {
  private entries = new Map<string, Entry>();
  private retry = new Map<string, number>();
  private after = "00000000-0000-0000-0000-000000000000";
  private controller = new AbortController();
  private maintenance?: Promise<void>;
  constructor(
    private s: MailService,
    private max: number,
    private queue = new ChangeQueue(s),
    private now = Date.now,
  ) {}
  get size() {
    return this.entries.size;
  }
  start() {
    if (this.maintenance) return;
    this.maintenance = (async () => {
      while (!this.controller.signal.aborted) {
        try {
          await this.tick();
        } catch {
          console.error("IMAP IDLE maintenance deferred");
        }
        await delay(10_000, undefined, {
          signal: this.controller.signal,
        }).catch(() => {});
      }
    })();
  }
  async tick() {
    if (this.controller.signal.aborted) return;
    for (const [id, until] of this.retry)
      if (until <= this.now()) this.retry.delete(id);
    for (const entry of this.entries.values()) {
      let valid = false;
      try {
        await this.s.store.account(
          {
            tenant: entry.account.tenant,
            subject: entry.account.owner,
            client: "idle",
            scopes: [],
          },
          entry.account.id,
        );
        const r = await this.s.store.db.query(
          "UPDATE sessions SET expires_at=now()+interval '45 seconds' WHERE id=$1 AND data->>'token'=$2 AND expires_at>now() RETURNING id",
          ["idle:" + entry.account.id, entry.token],
        );
        valid = r.rows.length > 0;
      } catch {}
      if (!valid || this.now() - entry.opened >= 20 * 60_000 || this.max === 0)
        entry.controller.abort();
    }
    const available = this.max - this.entries.size;
    if (available <= 0) return;
    const rows = await this.s.store.db.query<{ data: Account }>(
      "SELECT data FROM accounts WHERE data->>'provider'='imap' AND data->>'revoked'='false' AND data->>'verified'='true' AND id>$1 ORDER BY id LIMIT $2",
      [this.after, available],
    );
    this.after =
      rows.rows.at(-1)?.data.id ?? "00000000-0000-0000-0000-000000000000";
    for (const { data: a } of rows.rows) {
      if (
        this.controller.signal.aborted ||
        this.entries.has(a.id) ||
        (this.retry.get(a.id) ?? 0) > this.now()
      )
        continue;
      const token = opaque();
      const lease = await this.s.store.db.query(
        "INSERT INTO sessions VALUES($1,$2,now()+interval '45 seconds') ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at WHERE sessions.expires_at<now() RETURNING id",
        ["idle:" + a.id, JSON.stringify({ token })],
      );
      if (!lease.rows.length) continue;
      const entry: Entry = {
        account: a,
        token,
        controller: new AbortController(),
        opened: this.now(),
        done: Promise.resolve(),
      };
      this.entries.set(a.id, entry);
      entry.done = (async () => {
        try {
          const provider = await this.s.providers(a);
          if (!provider.watch) throw Error("IDLE_UNSUPPORTED");
          await this.queue.enqueue(a);
          await provider.watch(
            "INBOX",
            () => {
              void this.queue.enqueue(a).catch(() => {});
            },
            entry.controller.signal,
          );
        } catch {
          this.retry.set(a.id, this.now() + 60_000);
        } finally {
          await this.s.store.db
            .query("DELETE FROM sessions WHERE id=$1 AND data->>'token'=$2", [
              "idle:" + a.id,
              token,
            ])
            .catch(() => {});
          if (this.entries.get(a.id) === entry) this.entries.delete(a.id);
        }
      })();
    }
  }
  async close() {
    this.controller.abort();
    await this.maintenance;
    const entries = [...this.entries.values()];
    for (const e of entries) e.controller.abort();
    await Promise.all(entries.map((e) => e.done));
  }
}
