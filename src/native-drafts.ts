import {
  MailError,
  draftSchema,
  type Principal,
  type Draft,
  type DraftContent,
} from "./domain.js";
import { cleanHtml, type MailService } from "./service.js";
import { hash, opaque } from "./crypto.js";
import { id } from "./store.js";
type Binding = {
  id: string;
  draftId: string;
  remoteId: string;
  enabled: boolean;
  autoPush: boolean;
  status: string;
  baseLocal: string;
  baseRemote: string;
  attachments: string;
  nextCheck: string;
  remoteVersion: string;
  error?: string;
  writingAt?: string;
};
const clean = (d: DraftContent) =>
  draftSchema.parse({ ...d, ...(d.html ? { html: cleanHtml(d.html) } : {}) });
const bodyHash = (d: DraftContent) =>
  hash(
    JSON.stringify({
      ...clean(d),
      text: d.text.replace(/\r\n/g, "\n").trimEnd(),
      attachmentIds: [],
    }),
  );
const remoteHash = (r: { version: string; content: DraftContent }) =>
  hash(r.version + ":" + bodyHash(r.content));
export class NativeDrafts {
  constructor(private s: MailService) {}
  private async local(p: Principal, accountId: string, d: Draft) {
    const attachments = [];
    for (const id of d.content.attachmentIds) {
      const a = await this.s.uploaded(p, accountId, id);
      attachments.push({
        filename: a.name,
        contentType: a.type,
        content: a.content,
      });
    }
    const digest = hash(
      JSON.stringify(
        attachments
          .map((a) => [a.filename, a.contentType, hash(a.content)])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    );
    return { attachments, digest, hash: hash(bodyHash(d.content) + digest) };
  }
  private async pullContent(
    p: Principal,
    accountId: string,
    r: Awaited<
      ReturnType<NonNullable<import("./domain.js").MailProvider["nativeDraft"]>>
    >,
  ) {
    if (r.message.attachments.length > 20)
      throw new MailError("TOO_MANY_ATTACHMENTS", 413);
    const attachmentIds: string[] = [];
    let total = 0;
    for (const attachment of r.message.attachments) {
      const a = await this.s.attachment(
        p,
        accountId,
        r.message.id,
        attachment.id,
      );
      total += a.content.length;
      if (total > 8 * 1024 * 1024)
        throw new MailError("ATTACHMENTS_TOO_LARGE", 413);
      attachmentIds.push(
        (await this.s.upload(p, accountId, a.name, a.type, a.content)).id,
      );
    }
    return clean({ ...r.content, attachmentIds });
  }
  async bind(
    p: Principal,
    accountId: string,
    remoteId: string,
    autoPush = false,
  ) {
    const a = await this.s.account(p, accountId, "mail.write"),
      provider = await this.s.providers(a);
    if (!provider.nativeDraft || !provider.updateNativeDraft)
      throw new MailError("NATIVE_SYNC_UNSUPPORTED", 422);
    const r = await provider.nativeDraft(remoteId),
      d = await this.s.createDraft(
        p,
        accountId,
        await this.pullContent(p, accountId, r),
      ),
      local = await this.local(p, accountId, d);
    const binding: Binding = {
      id: id(),
      draftId: d.id,
      remoteId,
      enabled: true,
      autoPush,
      status: "clean",
      baseLocal: local.hash,
      baseRemote: remoteHash(r),
      attachments: local.digest,
      nextCheck: new Date().toISOString(),
      remoteVersion: r.version,
    };
    await this.s.store.put(p, accountId, "native_binding", binding.id, binding);
    return {
      binding,
      draft: d,
      concurrency:
        a.provider === "gmail"
          ? "Gmail best-effort read-before-write; no atomic remote CAS"
          : "provider-version-check; attachments preserved",
    };
  }
  async list(p: Principal, accountId: string, offset = 0) {
    await this.s.account(p, accountId);
    const items = await this.s.store.list<Binding>(
      p,
      accountId,
      "native_binding",
      51,
      offset,
    );
    return {
      items: items.slice(0, 50),
      next_offset: items.length > 50 ? offset + 50 : null,
    };
  }
  async stop(p: Principal, accountId: string, bindingId: string) {
    await this.s.account(p, accountId, "mail.write");
    const b = await this.s.store.get<Binding>(
      p,
      accountId,
      "native_binding",
      bindingId,
    );
    b.enabled = false;
    await this.s.store.put(p, accountId, "native_binding", b.id, b);
    return b;
  }
  async sync(
    p: Principal,
    accountId: string,
    bindingId: string,
    resolve?: "pull" | "push",
    revision?: number,
    version?: string,
  ) {
    const a = await this.s.account(p, accountId, "mail.write"),
      key = "native:" + bindingId,
      token = opaque();
    const lease = await this.s.store.db.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at WHERE sessions.expires_at<now() RETURNING id",
      [key, JSON.stringify({ token })],
    );
    if (!lease.rows.length) throw new MailError("NATIVE_SYNC_BUSY", 409);
    const save = async (b: Binding, updated?: Draft, expected?: number) =>
      this.s.store.db.transaction(async (tx) => {
        await this.s.store.account(p, accountId, tx, true, "mail.write");
        const current = await this.s.store.get<Binding>(
          p,
          accountId,
          "native_binding",
          b.id,
          tx,
          true,
        );
        if (!current.enabled && b.enabled)
          throw new MailError("NATIVE_LINK_STOPPED", 409);
        if (
          !(
            await tx.query(
              "SELECT id FROM sessions WHERE id=$1 AND data->>'token'=$2 AND expires_at>now() FOR UPDATE",
              [key, token],
            )
          ).rows.length
        )
          throw new MailError("NATIVE_LEASE_LOST", 409);
        if (updated) {
          const currentDraft = await this.s.store.get<Draft>(
            p,
            accountId,
            "draft",
            updated.id,
            tx,
            true,
          );
          if (currentDraft.revision !== expected)
            throw new MailError("REVISION_CONFLICT", 409);
          await this.s.store.put(
            p,
            accountId,
            "draft",
            updated.id,
            updated,
            tx,
          );
        }
        await this.s.store.put(p, accountId, "native_binding", b.id, b, tx);
      });
    try {
      const b = await this.s.store.get<Binding>(
        p,
        accountId,
        "native_binding",
        bindingId,
      );
      if (!b.enabled) return b;
      if (b.status === "writing") b.status = "unknown";
      if (["unknown", "conflict"].includes(b.status) && !resolve) return b;
      const provider = await this.s.providers(a);
      if (!provider.nativeDraft || !provider.updateNativeDraft)
        throw new MailError("NATIVE_SYNC_UNSUPPORTED", 422);
      const d = await this.s.store.get<Draft>(p, accountId, "draft", b.draftId),
        local = await this.local(p, accountId, d),
        remote = await provider.nativeDraft(b.remoteId);
      if (resolve && (revision !== d.revision || version !== remote.version))
        throw new MailError("REVISION_CONFLICT", 409);
      const localChanged = local.hash !== b.baseLocal,
        remoteChanged = remoteHash(remote) !== b.baseRemote;
      b.remoteVersion = remote.version;
      b.nextCheck = new Date(Date.now() + 60_000).toISOString();
      if (localChanged && remoteChanged && !resolve) {
        b.status = "conflict";
        await save(b);
        return b;
      }
      if (resolve === "pull" || (remoteChanged && !localChanged)) {
        const content = await this.pullContent(p, accountId, remote),
          updated: Draft = {
            ...d,
            content,
            revision: d.revision + 1,
            updatedAt: new Date().toISOString(),
          },
          now = await this.local(p, accountId, updated);
        b.baseLocal = now.hash;
        b.attachments = now.digest;
        b.baseRemote = remoteHash(remote);
        b.status = "clean";
        await save(b, updated, d.revision);
        return b;
      } else if (resolve === "push" || (localChanged && b.autoPush)) {
        const replaceAttachments = local.digest !== b.attachments;
        if (
          a.provider === "graph" &&
          replaceAttachments &&
          local.attachments.some((a) => a.content.length >= 3_000_000)
        ) {
          b.status = "conflict";
          b.error = "NATIVE_ATTACHMENT_REQUIRES_UPLOAD_SESSION";
          await save(b);
          return b;
        }
        b.status = "writing";
        b.writingAt = new Date().toISOString();
        await save(b);
        try {
          await provider.updateNativeDraft(
            b.remoteId,
            remote.version,
            d.content,
            local.attachments,
            replaceAttachments,
            async () => {
              await this.s.account(p, accountId, "mail.write");
              const current = await this.s.store.get<Binding>(
                p,
                accountId,
                "native_binding",
                b.id,
              );
              if (!current.enabled)
                throw new MailError("NATIVE_LINK_STOPPED", 409);
              if (
                !(
                  await this.s.store.db.query(
                    "SELECT id FROM sessions WHERE id=$1 AND data->>'token'=$2 AND expires_at>now()",
                    [key, token],
                  )
                ).rows.length
              )
                throw new MailError("NATIVE_LEASE_LOST", 409);
            },
          );
          const after = await provider.nativeDraft(b.remoteId);
          b.baseLocal = local.hash;
          b.attachments = local.digest;
          b.baseRemote = remoteHash(after);
          b.remoteVersion = after.version;
          b.status =
            bodyHash(after.content) === bodyHash(d.content)
              ? "clean"
              : "conflict";
          if (a.provider === "graph" && replaceAttachments) {
            const snapshots = [];
            for (const attachment of after.message.attachments) {
              const item = await this.s.attachment(
                p,
                accountId,
                after.message.id,
                attachment.id,
              );
              snapshots.push([item.name, item.type, hash(item.content)]);
            }
            const actual = hash(
              JSON.stringify(
                snapshots.sort((a, b) =>
                  JSON.stringify(a).localeCompare(JSON.stringify(b)),
                ),
              ),
            );
            const latest = await provider.nativeDraft(b.remoteId);
            if (actual !== local.digest || latest.version !== after.version)
              b.status = "conflict";
          }
        } catch (e) {
          b.status =
            e instanceof MailError && e.code === "REVISION_CONFLICT"
              ? "conflict"
              : "unknown";
          b.error = e instanceof MailError ? e.code : "PROVIDER_RESULT_UNKNOWN";
          await save(b);
          return b;
        }
      } else b.status = localChanged ? "local_changes" : "clean";
      await save(b);
      return b;
    } finally {
      await this.s.store.db.query(
        "DELETE FROM sessions WHERE id=$1 AND data->>'token'=$2",
        [key, token],
      );
    }
  }
  async tick(signal?: AbortSignal) {
    await this.s.store.db.query(
      "UPDATE documents SET data=jsonb_set(data,'{status}','\"unknown\"') WHERE kind='native_binding' AND data->>'status'='writing' AND COALESCE(data->>'writingAt','1970-01-01')::timestamptz < now()-interval '2 minutes'",
    );
    const rows = await this.s.store.db.query<{
      account_id: string;
      owner: string;
      tenant: string;
      id: string;
    }>(
      "SELECT account_id,owner,tenant,id FROM documents WHERE kind='native_binding' AND data->>'enabled'='true' AND data->>'status' NOT IN ('unknown','writing','conflict') AND (data->>'nextCheck')::timestamptz<=now() ORDER BY data->>'nextCheck',id LIMIT 20",
    );
    for (const r of rows.rows) {
      if (signal?.aborted) break;
      try {
        await this.sync(
          {
            subject: r.owner,
            tenant: r.tenant,
            client: "native-worker",
            scopes: ["mail.read", "mail.write"],
          },
          r.account_id,
          r.id,
        );
      } catch {
        await this.s.store.db.query(
          "UPDATE documents SET data=jsonb_set(data,'{nextCheck}',$2::jsonb) WHERE id=$1 AND kind='native_binding'",
          [r.id, JSON.stringify(new Date(Date.now() + 300_000).toISOString())],
        );
      }
    }
  }
}
