import pg from "pg";
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
export const migration = `
CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);
INSERT INTO schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS accounts (id uuid PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS accounts_owner ON accounts(tenant,owner);
CREATE TABLE IF NOT EXISTS documents (id uuid PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS documents_scope ON documents(tenant,owner,account_id,kind);
CREATE TABLE IF NOT EXISTS operations (id uuid PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, account_id uuid NOT NULL REFERENCES accounts(id), client text NOT NULL, dedupe text NOT NULL, state text NOT NULL, due_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE(tenant,owner,account_id,dedupe));
CREATE INDEX IF NOT EXISTS operations_due ON operations(state,due_at);
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, account_id uuid, action text NOT NULL, object_id text, outcome text NOT NULL, at timestamptz NOT NULL DEFAULT now());
`;
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(17633001)");
    await tx.query(migration);
    const v = await tx.query<{ version: number }>(
      "SELECT version FROM schema_version",
    );
    if (v.rows.some((r) => r.version > 1))
      throw new Error(
        "Database is newer than this executable; refusing unsafe rollback",
      );
  });
}
