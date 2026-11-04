import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import {
  MailError,
  requireScope,
  type Principal,
  type Account,
} from "./domain.js";
import { opaque, secretEqual } from "./crypto.js";
import { stableId } from "./sync.js";
import { ChangeQueue } from "./change-queue.js";
import type { MailService } from "./service.js";
import type { Config } from "./config.js";
export type PushVerify = (token: string) => Promise<void>;
export function gmailPushVerifier(
  c: Config,
  key: JWTVerifyGetKey = createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
  ),
): PushVerify {
  return async (token) => {
    if (!c.GMAIL_PUSH_IDENTITY)
      throw new MailError("GMAIL_PUSH_NOT_CONFIGURED", 503);
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: c.BASE_URL + "/webhooks/gmail",
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (
        payload.email !== c.GMAIL_PUSH_IDENTITY ||
        payload.email_verified !== true
      )
        throw Error("identity");
    } catch {
      throw new MailError("PUSH_AUTH_REQUIRED", 401);
    }
  };
}
type Record = {
  id: string;
  accountId: string;
  provider: "gmail" | "graph";
  generation: string;
  enabled: boolean;
  status: "starting" | "active" | "uncertain" | "disabled";
  sealed: string;
  providerId?: string;
  expiresAt?: string;
  renewAt: string;
  lastError?: string;
};
type Lease = { key: string; token: string };
const publicRecord = (r: Record) => ({
  provider: r.provider,
  enabled: r.enabled,
  status: r.status,
  expiresAt: r.expiresAt,
  renewAt: r.renewAt,
  ...(r.lastError ? { lastError: r.lastError } : {}),
});
const context = (a: Account) => `push:${a.tenant}:${a.owner}:${a.id}`;
const principal = (a: Account): Principal => ({
  tenant: a.tenant,
  subject: a.owner,
  client: "push-worker",
  scopes: ["mail.read", "mail.write"],
});
export async function notificationStatus(
  s: MailService,
  p: Principal,
  id: string,
) {
  const a = await s.account(p, id);
  let record: Record | undefined;
  try {
    record = await s.store.get<Record>(p, id, "push", stableId(id + ":push"));
  } catch (e) {
    if (!(e instanceof MailError && e.code === "NOT_FOUND")) throw e;
  }
  return {
    ...(record ? publicRecord(record) : { enabled: false, status: "disabled" }),
    ...(a.provider === "imap"
      ? {
          imap_idle: {
            worker_assigned: Boolean(await s.store.session("idle:" + id)),
            folder: "INBOX",
          },
        }
      : {}),
    fallback: "periodic_reconciliation",
    manage_url: `${s.baseUrl}/api/push/${id}`,
  };
}
export class PushService {
  private queue: ChangeQueue;
  constructor(
    private s: MailService,
    private c: Config,
  ) {
    this.queue = new ChangeQueue(s);
  }
  private async locked<T>(accountId: string, fn: (lease: Lease) => Promise<T>) {
    const key = "push-lease:" + accountId,
      token = opaque();
    const r = await this.s.store.db.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at WHERE sessions.expires_at<now() RETURNING id",
      [key, JSON.stringify({ token })],
    );
    if (!r.rows.length) throw new MailError("PUSH_BUSY", 409);
    try {
      return await fn({ key, token });
    } finally {
      await this.s.store.db.query(
        "DELETE FROM sessions WHERE id=$1 AND data->>'token'=$2",
        [key, token],
      );
    }
  }
  private async save(p: Principal, a: Account, r: Record, lease: Lease) {
    await this.s.store.db.transaction(async (tx) => {
      await this.s.store.account(p, a.id, tx, true);
      const own = await tx.query(
        "SELECT id FROM sessions WHERE id=$1 AND data->>'token'=$2 AND expires_at>now() FOR UPDATE",
        [lease.key, lease.token],
      );
      if (!own.rows.length) throw new MailError("PUSH_LEASE_LOST", 409);
      await this.s.store.put(p, a.id, "push", r.id, r, tx);
    });
  }
  private async current(p: Principal, a: Account) {
    try {
      return await this.s.store.get<Record>(
        p,
        a.id,
        "push",
        stableId(a.id + ":push"),
      );
    } catch (e) {
      if (e instanceof MailError && e.code === "NOT_FOUND") return undefined;
      throw e;
    }
  }
  async status(p: Principal, id: string) {
    return notificationStatus(this.s, p, id);
  }
  async enable(p: Principal, id: string) {
    requireScope(p, "mail.write");
    await this.s.owner(p, id);
    await this.s.account(p, id);
    return this.locked(id, async (lease) => {
      const a = await this.s.account(p, id);
      if (!["gmail", "graph"].includes(a.provider))
        throw new MailError("PUSH_UNSUPPORTED", 422);
      if (!this.c.BASE_URL.startsWith("https:"))
        throw new MailError("PUSH_REQUIRES_HTTPS", 503);
      if (
        a.provider === "gmail" &&
        (!this.c.GMAIL_PUSH_TOPIC || !this.c.GMAIL_PUSH_IDENTITY)
      )
        throw new MailError("GMAIL_PUSH_NOT_CONFIGURED", 503);
      let r = await this.current(p, a);
      if (
        r?.enabled &&
        r.status === "active" &&
        Date.parse(r.renewAt) > Date.now()
      )
        return publicRecord(r);
      const state = r?.enabled
        ? r.sealed
        : this.s.vault.seal({ clientState: opaque() }, context(a));
      r = {
        id: stableId(id + ":push"),
        accountId: id,
        provider: a.provider as "gmail" | "graph",
        generation: opaque(),
        enabled: true,
        status: "starting",
        sealed: state,
        providerId: r?.enabled ? r.providerId : undefined,
        expiresAt: r?.enabled ? r.expiresAt : undefined,
        renewAt: new Date().toISOString(),
      };
      await this.save(p, a, r, lease);
      try {
        const provider = await this.s.providers(a);
        if (!provider.subscribe) throw new MailError("PUSH_UNSUPPORTED", 422);
        const { clientState } = this.s.vault.open<{ clientState: string }>(
          state,
          context(a),
        );
        const subscription = await provider.subscribe({
          callback: this.c.BASE_URL + "/webhooks/graph",
          clientState,
          topic: this.c.GMAIL_PUSH_TOPIC,
          id: r.providerId,
        });
        r = {
          ...r,
          status: "active",
          providerId: subscription.id,
          expiresAt: subscription.expiresAt,
          renewAt: new Date(
            Math.min(
              Date.now() + 86400_000,
              Date.parse(subscription.expiresAt) - 12 * 3600_000,
            ),
          ).toISOString(),
        };
        await this.save(p, a, r, lease);
        await this.queue.enqueue(a);
        await this.s.store.audit(p, id, "push.enable", r.id, "ok");
        return publicRecord(r);
      } catch (e) {
        const unsupported =
          e instanceof MailError &&
          ["PUSH_UNSUPPORTED", "SHARED_MAILBOX_PUSH_UNSUPPORTED"].includes(
            e.code,
          );
        r = {
          ...r,
          status: unsupported ? "disabled" : "uncertain",
          enabled: !unsupported,
          renewAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          lastError: e instanceof MailError ? e.code : "PROVIDER_ERROR",
        };
        // Revocation can have deleted the record while the provider was responding.
        try {
          await this.save(p, a, r, lease);
        } catch {}
        throw e;
      }
    });
  }
  async disable(p: Principal, id: string) {
    requireScope(p, "mail.write");
    await this.s.owner(p, id);
    await this.s.account(p, id);
    return this.locked(id, async (lease) => {
      const a = await this.s.account(p, id),
        r = await this.current(p, a);
      if (!r) return { enabled: false, status: "disabled" };
      // Reject callbacks locally before attempting remote cancellation.
      r.enabled = false;
      r.status = "disabled";
      await this.save(p, a, r, lease);
      let remote =
        "not_confirmed; provider subscription may persist until expiry";
      if (r.providerId) {
        try {
          await (await this.s.providers(a)).unsubscribe?.(r.providerId);
          remote = "stopped";
        } catch {
          remote = "unknown; provider subscription may persist until expiry";
        }
      }
      return { ...publicRecord(r), remote };
    });
  }
  async renew(signal?: AbortSignal) {
    const rows = await this.s.store.db.query<{ data: Account }>(
      "SELECT a.data FROM accounts a JOIN documents d ON d.account_id=a.id AND d.kind='push' WHERE a.data->>'revoked'='false' AND d.data->>'enabled'='true' AND (d.data->>'renewAt')::timestamptz<=now() ORDER BY d.id LIMIT 20",
    );
    for (const { data: a } of rows.rows) {
      if (signal?.aborted) break;
      try {
        await this.enable(principal(a), a.id);
      } catch {
        /* periodic reconciliation remains active */
      }
    }
  }
  async graph(body: unknown) {
    const data = z
      .object({
        value: z
          .array(
            z
              .object({
                subscriptionId: z.string().max(500),
                clientState: z.string().max(200).optional(),
                lifecycleEvent: z.string().optional(),
              })
              .passthrough(),
          )
          .max(1000),
      })
      .parse(body);
    if (!data.value.length) return;
    const rows = await this.s.store.db.query<{
      account: Account;
      record: Record;
    }>(
      "SELECT a.data AS account,d.data AS record FROM documents d JOIN accounts a ON a.id=d.account_id WHERE d.kind='push' AND d.data->>'provider'='graph' AND d.data->>'providerId'=ANY($1::text[]) AND d.data->>'enabled'='true' AND a.data->>'revoked'='false'",
      [[...new Set(data.value.map((x) => x.subscriptionId))]],
    );
    const accounts: Account[] = [];
    for (const { account: a, record: r } of rows.rows) {
      if (!r.expiresAt || Date.parse(r.expiresAt) <= Date.now()) continue;
      const state = this.s.vault.open<{ clientState: string }>(
        r.sealed,
        context(a),
      );
      const matched = data.value.filter(
        (n) =>
          n.subscriptionId === r.providerId &&
          secretEqual(n.clientState ?? "", state.clientState),
      );
      if (!matched.length) continue;
      if (matched.some((n) => n.lifecycleEvent))
        await this.s.store.db.query(
          "UPDATE documents SET data=jsonb_set(data,'{renewAt}',$3::jsonb) WHERE id=$1 AND data->>'generation'=$2",
          [r.id, r.generation, JSON.stringify(new Date().toISOString())],
        );
      accounts.push(a);
    }
    await this.queue.enqueueMany(accounts);
  }
  async gmail(body: unknown) {
    const message = z
      .object({
        message: z.object({ data: z.string().max(20000) }).passthrough(),
      })
      .passthrough()
      .parse(body);
    let value;
    try {
      value = JSON.parse(
        Buffer.from(message.message.data, "base64").toString(),
      );
    } catch {
      throw new MailError("INVALID_PUSH_PAYLOAD");
    }
    const { emailAddress } = z
      .object({
        emailAddress: z.string().email(),
        historyId: z.string().regex(/^\d+$/),
      })
      .parse(value);
    const rows = await this.s.store.db.query<{
      account: Account;
      record: Record;
    }>(
      "SELECT a.data AS account,d.data AS record FROM documents d JOIN accounts a ON a.id=d.account_id WHERE d.kind='push' AND d.data->>'provider'='gmail' AND d.data->>'enabled'='true' AND a.data->>'revoked'='false' AND a.data->>'email'=$1",
      [emailAddress.toLowerCase()],
    );
    await this.queue.enqueueMany(
      rows.rows
        .filter(
          ({ record: r }) =>
            r.expiresAt && Date.parse(r.expiresAt) > Date.now(),
        )
        .map(({ account: a }) => a),
    );
    // historyId is only a hint; never overwrite a committed sync checkpoint.
  }
}
