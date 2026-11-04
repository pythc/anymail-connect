import { opaque } from "./crypto.js";
import { stableId, Synchronizer } from "./sync.js";
import { MailError, type Account } from "./domain.js";
import type { MailService } from "./service.js";
type Change = {
  id: string;
  tenant: string;
  owner: string;
  account_id: string;
  folder: string;
  token: string;
};
export class ChangeQueue {
  constructor(private s: MailService) {}
  async enqueue(a: Pick<Account, "id" | "tenant" | "owner">, folder = "INBOX") {
    return this.enqueueMany([{ ...a, folder }]);
  }
  async enqueueMany(
    accounts: (Pick<Account, "id" | "tenant" | "owner"> & {
      folder?: string;
    })[],
  ) {
    const records = [
      ...new Map(
        accounts.map((a) => {
          const folder = a.folder ?? "INBOX",
            request_id = stableId(a.id + ":" + folder);
          return [
            request_id,
            {
              id: a.id,
              tenant: a.tenant,
              owner: a.owner,
              folder,
              request_id,
              token: opaque(),
            },
          ];
        }),
      ).values(),
    ];
    if (!records.length) return;
    await this.s.store.db.query(
      `WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,tenant text,owner text,folder text,request_id uuid,token text)),
      locked AS (SELECT a.id,a.tenant,a.owner FROM accounts a WHERE EXISTS (SELECT 1 FROM requested r WHERE a.id=r.id AND a.tenant=r.tenant AND a.owner=r.owner) AND a.data->>'revoked'='false' AND a.data->>'verified'='true' ORDER BY a.id FOR UPDATE OF a)
      INSERT INTO change_requests SELECT r.request_id,r.tenant,r.owner,r.id,r.folder,r.token,now() FROM requested r JOIN locked l ON l.id=r.id AND l.tenant=r.tenant AND l.owner=r.owner
      ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,retry_at=EXCLUDED.retry_at`,
      [JSON.stringify(records)],
    );
  }
  async drain(limit = 20, signal?: AbortSignal) {
    const rows = await this.s.store.db.query<Change>(
      "SELECT * FROM change_requests WHERE retry_at<=now() ORDER BY retry_at,id LIMIT $1",
      [limit],
    );
    let processed = 0;
    for (const c of rows.rows) {
      if (signal?.aborted) break;
      processed++;
      const p = {
        tenant: c.tenant,
        subject: c.owner,
        client: "change-worker",
        scopes: ["mail.read"],
      };
      try {
        const state = await new Synchronizer(this.s).run(
          p,
          c.account_id,
          c.folder,
        );
        if (!state.complete)
          await this.enqueue(
            { id: c.account_id, tenant: c.tenant, owner: c.owner },
            c.folder,
          );
      } catch (e) {
        if (!(
          e instanceof MailError &&
          ["ACCOUNT_REVOKED", "NOT_FOUND"].includes(e.code)
        )) {
          await this.s.store.db.query(
            "UPDATE change_requests SET retry_at=now()+interval '1 minute' WHERE id=$1 AND token=$2",
            [c.id, c.token],
          );
          continue;
        }
      }
      // Leave a newer signal intact, including one enqueued during synchronization.
      await this.s.store.db.query(
        "DELETE FROM change_requests WHERE id=$1 AND token=$2",
        [c.id, c.token],
      );
    }
    return processed;
  }
}
