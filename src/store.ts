import { randomUUID } from "node:crypto";
import { type Database, type Queryable } from "./db.js";
import { MailError, type Account, type Principal } from "./domain.js";
export class Store {
  constructor(public db: Database) {}
  async accounts(p: Principal): Promise<Account[]> {
    return (
      await this.db.query<{ data: Account }>(
        "SELECT data FROM accounts a WHERE tenant=$1 AND (owner=$2 OR EXISTS(SELECT 1 FROM account_grants g WHERE g.account_id=a.id AND g.tenant=a.tenant AND g.subject=$2 AND g.expires_at>now())) ORDER BY id",
        [p.tenant, p.subject],
      )
    ).rows.map((r) => r.data);
  }
  async account(
    p: Principal,
    id: string,
    tx: Queryable = this.db,
    lock = false,
    scope = "mail.read",
  ): Promise<Account> {
    const r = await tx.query<{ data: Account }>(
      "SELECT data FROM accounts WHERE tenant=$1 AND id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [p.tenant, id],
    );
    if (!r.rows[0]) throw new MailError("NOT_FOUND", 404);
    if (r.rows[0].data.owner !== p.subject) {
      const grant = await tx.query<{ scopes: string[] }>(
        "SELECT scopes FROM account_grants WHERE account_id=$1 AND tenant=$2 AND subject=$3 AND expires_at>now()",
        [id, p.tenant, p.subject],
      );
      if (!grant.rows[0]) throw new MailError("NOT_FOUND", 404);
      if (!grant.rows[0].scopes.includes(scope))
        throw new MailError("PERMISSION_DENIED", 403);
    }
    if (r.rows[0].data.revoked) throw new MailError("ACCOUNT_REVOKED", 403);
    return r.rows[0].data;
  }
  async addAccount(a: Account) {
    await this.db.query("INSERT INTO accounts VALUES($1,$2,$3,$4)", [
      a.id,
      a.tenant,
      a.owner,
      JSON.stringify(a),
    ]);
  }
  async updateAccount(a: Account, tx: Queryable = this.db) {
    await tx.query(
      "UPDATE accounts SET data=$4 WHERE id=$1 AND tenant=$2 AND owner=$3",
      [a.id, a.tenant, a.owner, JSON.stringify(a)],
    );
  }
  async put(
    p: Principal,
    accountId: string,
    kind: string,
    id: string,
    data: unknown,
    tx: Queryable = this.db,
  ) {
    if (tx === this.db) {
      return this.db.transaction(async (locked) => {
        await this.account(
          p,
          accountId,
          locked,
          true,
          ["draft", "blob", "native_binding"].includes(kind)
            ? "mail.write"
            : "mail.read",
        );
        await this.put(p, accountId, kind, id, data, locked);
      });
    }
    await this.account(
      p,
      accountId,
      tx,
      false,
      ["draft", "blob", "native_binding"].includes(kind)
        ? "mail.write"
        : "mail.read",
    );
    // Explicit transaction callers hold the account lock before document locks.
    await tx.query(
      "INSERT INTO documents VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data WHERE documents.tenant=EXCLUDED.tenant AND documents.owner=EXCLUDED.owner AND documents.account_id=EXCLUDED.account_id AND documents.kind=EXCLUDED.kind",
      [id, p.tenant, p.subject, accountId, kind, JSON.stringify(data)],
    );
  }
  async get<T>(
    p: Principal,
    accountId: string,
    kind: string,
    id: string,
    tx: Queryable = this.db,
    lock = false,
  ): Promise<T> {
    await this.account(p, accountId, tx);
    const r = await tx.query<{ data: T }>(
      "SELECT data FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind=$4 AND id=$5" +
        (lock ? " FOR UPDATE" : ""),
      [p.tenant, p.subject, accountId, kind, id],
    );
    if (!r.rows[0]) throw new MailError("NOT_FOUND", 404);
    return r.rows[0].data;
  }
  async list<T>(
    p: Principal,
    accountId: string,
    kind: string,
    limit = 50,
    offset = 0,
  ): Promise<T[]> {
    await this.account(p, accountId);
    return (
      await this.db.query<{ data: T }>(
        "SELECT data FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind=$4 ORDER BY id LIMIT $5 OFFSET $6",
        [p.tenant, p.subject, accountId, kind, limit, offset],
      )
    ).rows.map((r) => r.data);
  }
  async remove(p: Principal, accountId: string, kind: string, id: string) {
    await this.account(p, accountId, this.db, false, "mail.write");
    await this.db.query(
      "DELETE FROM documents WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND kind=$4 AND id=$5",
      [p.tenant, p.subject, accountId, kind, id],
    );
  }
  async session<T>(id: string): Promise<T | undefined> {
    return (
      await this.db.query<{ data: T }>(
        "SELECT data FROM sessions WHERE id=$1 AND expires_at>now()",
        [id],
      )
    ).rows[0]?.data;
  }
  async setSession(id: string, data: unknown, expires: string) {
    await this.db.query(
      "INSERT INTO sessions VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at",
      [id, JSON.stringify(data), expires],
    );
  }
  async consumeSession<T>(id: string): Promise<T | undefined> {
    return (
      await this.db.query<{ data: T }>(
        "DELETE FROM sessions WHERE id=$1 AND expires_at>now() RETURNING data",
        [id],
      )
    ).rows[0]?.data;
  }
  async audit(
    p: Principal,
    account: string | null,
    action: string,
    object: string | null,
    outcome: string,
    tx: Queryable = this.db,
  ) {
    await tx.query(
      "INSERT INTO audit(tenant,owner,account_id,action,object_id,outcome) VALUES($1,$2,$3,$4,$5,$6)",
      [p.tenant, p.subject, account, action, object, outcome],
    );
  }
}
export const id = () => randomUUID();
