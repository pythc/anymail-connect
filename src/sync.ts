import { hash, opaque } from "./crypto.js";
import { MailError, type Message, type Principal } from "./domain.js";
import type { MailService } from "./service.js";
export function stableId(value: string) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export class Synchronizer {
  constructor(private s: MailService) {}
  async run(p: Principal, accountId: string, folder = "INBOX") {
    const a = await this.s.account(p, accountId),
      key = stableId(
        `${accountId}:checkpoint:${a.provider === "gmail" ? "all" : folder}`,
      );
    // Use a session lease (CAS) instead of holding account locks during provider token refresh.
    if (a.owner !== p.subject) throw new MailError("OWNER_SYNC_REQUIRED", 403);
    const lease = "sync:" + key,
      leaseToken = opaque();
    const acquired = await this.s.store.db.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at WHERE sessions.expires_at<now() RETURNING id",
      [lease, JSON.stringify({ token: leaseToken })],
    );
    if (!acquired.rows.length) throw new MailError("SYNC_BUSY", 409);
    try {
      let old: any;
      try {
        old = await this.s.store.get(p, accountId, "checkpoint", key);
      } catch (e) {
        if (!(e instanceof MailError && e.status === 404)) throw e;
      }
      const provider = await this.s.providers(a);
      let batch;
      const generation =
        old?.cursor && old?.generation ? old.generation : opaque();
      if (provider.sync)
        batch = await provider.sync(
          old?.checkpoint,
          folder.toLowerCase() === "inbox" && a.provider === "graph"
            ? "inbox"
            : folder,
        );
      else {
        const result = await provider.search({
          query: "",
          folder,
          cursor: old?.cursor,
          limit: 50,
        });
        batch = {
          items: result.items,
          deleted: [],
          checkpoint: null,
          complete: !result.cursor,
          scope: result.coverage,
          cursor: result.cursor,
        };
      }
      const state = {
        checkpoint: batch.checkpoint,
        cursor: "cursor" in batch ? batch.cursor : undefined,
        generation,
        complete: batch.complete,
        scope: batch.scope,
        observedAt: new Date().toISOString(),
        kind: provider.sync ? "native-incremental" : "bounded-reconciliation",
        deletionTracking: true,
      };
      await this.s.store.db.transaction(async (tx) => {
        await this.s.store.account(p, accountId, tx, true);
        const leaseRow = await tx.query(
          "SELECT id FROM sessions WHERE id=$1 AND data->>'token'=$2 AND expires_at>now() FOR UPDATE",
          [lease, leaseToken],
        );
        if (!leaseRow.rows.length) throw new MailError("SYNC_LEASE_LOST", 409);
        if (batch.reset)
          await tx.query(
            "DELETE FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind='cache' AND data->>'_syncFolder'=$4",
            [p.tenant, p.subject, accountId, folder],
          );
        for (const messageId of batch.deleted)
          await tx.query(
            "DELETE FROM documents WHERE id=$1 AND tenant=$2 AND owner=$3 AND account_id=$4 AND kind='cache'",
            [
              stableId(`${accountId}:message:${messageId}`),
              p.tenant,
              p.subject,
              accountId,
            ],
          );
        for (const m of batch.items)
          await this.s.store.put(
            p,
            accountId,
            "cache",
            stableId(`${accountId}:message:${m.id}`),
            {
              ...m,
              _syncFolder: folder,
              _observedAt: state.observedAt,
              _generation: generation,
            },
            tx,
          );
        if (!provider.sync && batch.complete)
          await tx.query(
            "DELETE FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind='cache' AND data->>'_syncFolder'=$4 AND data->>'_generation' IS DISTINCT FROM $5",
            [p.tenant, p.subject, accountId, folder, generation],
          );
        await this.s.store.put(p, accountId, "checkpoint", key, state, tx);
      });
      return {
        ...state,
        updated: batch.items.length,
        deleted: batch.deleted.length,
      };
    } finally {
      await this.s.store.db.query(
        "DELETE FROM sessions WHERE id=$1 AND data->>'token'=$2",
        [lease, leaseToken],
      );
    }
  }
  async search(p: Principal, accountId: string, query: string, offset = 0) {
    const a = await this.s.account(p, accountId);
    const r = await this.s.store.db.query<{ data: Message }>(
      "SELECT data FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind='cache' AND (strpos(lower(data->>'subject'),lower($4))>0 OR strpos(lower(data->>'text'),lower($4))>0) ORDER BY data->>'date' DESC,id LIMIT 51 OFFSET $5",
      [p.tenant, a.owner, accountId, query, offset],
    );
    return {
      items: r.rows.slice(0, 50).map((x) => x.data),
      next_offset: r.rows.length > 50 ? offset + 50 : null,
      coverage:
        "local snapshot only; may be incomplete/stale; attachments not indexed",
      checkpoints: await this.s.store.list(
        { ...p, subject: a.owner },
        accountId,
        "checkpoint",
      ),
    };
  }
}
