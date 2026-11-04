import type { MailService } from "./service.js";
import type { Config } from "./config.js";
// Account locks serialize credential refresh, revocation and key rotation.
export async function rotateKeys(s: MailService, apply = false) {
  const counts = { accounts: 0, push: 0, sessions: 0 };
  const accounts = await s.store.db.query<{ id: string }>(
    "SELECT id FROM accounts ORDER BY id",
  );
  for (const { id } of accounts.rows)
    await s.store.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ tenant: string; owner: string; data: any }>(
          "SELECT tenant,owner,data FROM accounts WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row) return;
      const context = `${row.tenant}:${row.owner}:${id}`,
        a = row.data;
      if (a.secret) s.vault.open(a.secret, context);
      if (a.secret && !s.vault.current(a.secret)) {
        const clear = s.vault.open(a.secret, context);
        counts.accounts++;
        if (apply) {
          a.secret = s.vault.seal(clear, context);
          await tx.query("UPDATE accounts SET data=$2 WHERE id=$1", [
            id,
            JSON.stringify(a),
          ]);
        }
      }
      const docs = await tx.query<{ id: string; data: any }>(
        "SELECT id,data FROM documents WHERE account_id=$1 AND kind='push' FOR UPDATE",
        [id],
      );
      for (const d of docs.rows) {
        if (d.data.sealed)
          s.vault.open(d.data.sealed, `push:${row.tenant}:${row.owner}:${id}`);
        if (d.data.sealed && !s.vault.current(d.data.sealed)) {
          const ctx = `push:${row.tenant}:${row.owner}:${id}`,
            clear = s.vault.open(d.data.sealed, ctx);
          counts.push++;
          if (apply) {
            d.data.sealed = s.vault.seal(clear, ctx);
            await tx.query("UPDATE documents SET data=$2 WHERE id=$1", [
              d.id,
              JSON.stringify(d.data),
            ]);
          }
        }
      }
    });
  const sessions = await s.store.db.query<{ id: string }>(
    "SELECT id FROM sessions WHERE data ? 'sealed' ORDER BY id",
  );
  for (const { id } of sessions.rows)
    await s.store.db.transaction(async (tx) => {
      const r = (
        await tx.query<{ data: any }>(
          "SELECT data FROM sessions WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (r?.data.sealed) s.vault.open(r.data.sealed, id);
      if (r?.data.sealed && !s.vault.current(r.data.sealed)) {
        const clear = s.vault.open(r.data.sealed, id);
        counts.sessions++;
        if (apply) {
          r.data.sealed = s.vault.seal(clear, id);
          await tx.query("UPDATE sessions SET data=$2 WHERE id=$1", [
            id,
            JSON.stringify(r.data),
          ]);
        }
      }
    });
  return { apply, ...counts };
}
export async function retain(
  s: MailService,
  c: Pick<
    Config,
    "RETENTION_CACHE_DAYS" | "RETENTION_DRAFT_DAYS" | "RETENTION_AUDIT_DAYS"
  >,
  signal?: AbortSignal,
) {
  // Preserve send ledger/dedupe and all documents referenced by active sends.
  const accounts = await s.store.db.query<{ id: string }>(
    "SELECT id FROM accounts ORDER BY id",
  );
  let deleted = 0;
  for (const { id } of accounts.rows) {
    if (signal?.aborted) break;
    await s.store.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [id]);
      await tx.query(
        "UPDATE operations o SET state='cancelled',data=jsonb_set(o.data,'{state}','\"cancelled\"') WHERE account_id=$1 AND state IN ('pending','approved') AND EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=o.account_id AND g.tenant=o.tenant AND g.subject=o.owner AND g.expires_at<now())",
        [id],
      );
      await tx.query(
        "DELETE FROM account_grants WHERE account_id=$1 AND expires_at<now()",
        [id],
      );
      const r = await tx.query(
        `DELETE FROM documents WHERE id IN (
      SELECT d.id FROM documents d WHERE d.account_id=$1 AND (
        (d.kind IN ('cache','attachment_index') AND $2::int>0 AND COALESCE(d.data->>'_observedAt',d.data->>'indexedAt')::timestamptz < now()-make_interval(days=>$2::int)) OR
        (d.kind IN ('draft','blob') AND $3::int>0 AND COALESCE(d.data->>'updatedAt',d.data->>'createdAt')::timestamptz < now()-make_interval(days=>$3::int))
      ) AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.account_id=d.account_id AND o.state IN ('pending','approved','submitting','unknown') AND (o.data->>'draftId'=d.id::text OR o.data->'content'->'attachmentIds' ? d.id::text))
      AND NOT EXISTS (SELECT 1 FROM documents b WHERE b.account_id=d.account_id AND b.kind='native_binding' AND b.data->>'draftId'=d.id::text AND b.data->>'enabled'='true')
      AND NOT EXISTS (SELECT 1 FROM documents b WHERE b.account_id=d.account_id AND b.kind='draft' AND b.data->'content'->'attachmentIds' ? d.id::text)
      ORDER BY d.id LIMIT 1000) RETURNING id`,
        [id, c.RETENTION_CACHE_DAYS, c.RETENTION_DRAFT_DAYS],
      );
      deleted += r.rows.length;
    });
  }
  if (!signal?.aborted && c.RETENTION_AUDIT_DAYS > 0)
    await s.store.db.query(
      "DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at<now()-make_interval(days=>$1::int) ORDER BY id LIMIT 1000)",
      [c.RETENTION_AUDIT_DAYS],
    );
  return { deleted, send_ledger: "preserved" };
}
