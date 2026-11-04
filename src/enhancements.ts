import { z } from "zod";
import type { Tool } from "./tools.js";
import type { MailService } from "./service.js";
import { MailError } from "./domain.js";
import { httpClient } from "./network.js";
import { NativeDrafts } from "./native-drafts.js";
import { stableId } from "./sync.js";
import { hash } from "./crypto.js";
import { extract } from "./extract.js";
const account = z.string().uuid(),
  identifier = z.string().min(1).max(4000);
export function enhancements(s: MailService): Tool[] {
  const t: Tool[] = [],
    native = new NativeDrafts(s);
  const add = (
    name: string,
    description: string,
    schema: z.ZodObject<any>,
    readOnly: boolean,
    run: Tool["run"],
  ) => t.push({ name, description, schema, readOnly, run });
  add(
    "data_policy",
    "Read deployment retention/extraction policy. Zero days disables automatic deletion. Send ledger retained; attachment indexing is explicit.",
    z.object({}).strict(),
    true,
    async () => ({
      retention: s.features.retention ?? {
        cacheDays: 30,
        draftDays: 0,
        auditDays: 0,
      },
      ocr_enabled: !!s.features.ocr,
      send_ledger: "preserved",
      index_scope: "explicit private snapshots",
    }),
  );
  add(
    "accounts_grants",
    "List same-tenant sharing grants; owner only. Each member's drafts/uploads remain private.",
    z.object({ account_id: account }).strict(),
    true,
    (p, i) => s.grants(p, i.account_id),
  );
  add(
    "accounts_grant",
    "Explicitly grant a trusted IdP subject in this tenant mailbox scopes and expiry (up to1 year). Owner only; never infer immutable subject from email.",
    z
      .object({
        account_id: account,
        subject: z.string().min(1).max(200),
        scopes: z
          .array(z.enum(["mail.read", "mail.write", "mail.send"]))
          .min(1)
          .max(3),
        expires_at: z.string().datetime(),
      })
      .strict(),
    false,
    (p, i) => s.grant(p, i.account_id, i.subject, i.scopes, i.expires_at),
  );
  add(
    "accounts_revoke_grant",
    "Revoke user's access and cancel their pending/approved sends; submitted requests cannot be recalled.",
    z
      .object({ account_id: account, subject: z.string().min(1).max(200) })
      .strict(),
    false,
    (p, i) => s.revokeGrant(p, i.account_id, i.subject),
  );
  add(
    "native_drafts_bind",
    "Import existing native Gmail/Graph draft into a private application draft. auto_push opt-in; Gmail checks are best-effort without atomic CAS. Graph file attachments under3MB can be replaced; multi-request failures stop as unknown. Never retry unknown writes.",
    z
      .object({
        account_id: account,
        remote_id: identifier,
        auto_push: z.boolean().default(false),
      })
      .strict(),
    false,
    (p, i) => native.bind(p, i.account_id, i.remote_id, i.auto_push),
  );
  add(
    "native_drafts_list",
    "List private linked drafts/conflicts. Sending always requires exact-revision approval.",
    z
      .object({
        account_id: account,
        offset: z.number().int().min(0).max(100000).default(0),
      })
      .strict(),
    true,
    (p, i) => native.list(p, i.account_id, i.offset),
  );
  add(
    "native_drafts_inspect",
    "Read current local and remote draft snapshots/versions without writing or clearing conflict/unknown. Inspect before choosing explicit resolution.",
    z.object({ account_id: account, binding_id: account }).strict(),
    true,
    (p, i) => native.inspect(p, i.account_id, i.binding_id),
  );
  add(
    "native_drafts_sync",
    "Reconcile linked draft; both-side changes stop as conflict. Explicit resolution requires pull/push and current application revision plus remote version. Do not blindly retry unknown results.",
    z
      .object({
        account_id: account,
        binding_id: account,
        resolve: z.enum(["pull", "push"]).optional(),
        revision: z.number().int().positive().optional(),
        remote_version: z.string().max(4000).optional(),
      })
      .strict(),
    false,
    (p, i) =>
      native.sync(
        p,
        i.account_id,
        i.binding_id,
        i.resolve,
        i.revision,
        i.remote_version,
      ),
  );
  add(
    "native_drafts_stop",
    "Stop link without deleting drafts.",
    z.object({ account_id: account, binding_id: account }).strict(),
    false,
    (p, i) => native.stop(p, i.account_id, i.binding_id),
  );
  const selected = z
    .object({
      account_id: account,
      message_id: identifier,
      attachment_id: identifier,
    })
    .strict();
  add(
    "attachments_export",
    "Expose selected attachment via authenticated MCP resource_link/resources.read. Host support required; does not create official OpenAI file IDs or public links.",
    selected,
    true,
    async (p, i) => {
      const a = await s.attachment(
        p,
        i.account_id,
        i.message_id,
        i.attachment_id,
      );
      return {
        resource: {
          uri: `anymail://attachment/${i.account_id}/${encodeURIComponent(i.message_id)}/${encodeURIComponent(i.attachment_id)}`,
          name: a.name,
          mimeType: a.type,
          size: a.content.length,
        },
        download_url: `${s.baseUrl}/api/attachments/${i.account_id}/${encodeURIComponent(i.message_id)}/${encodeURIComponent(i.attachment_id)}`,
        authentication: "current user required",
      };
    },
  );
  add(
    "attachments_import_file",
    "Import explicitly selected host file into private draft uploads; never sends. Administrator-approved HTTPS origin only; no redirects or forwarded mailbox credentials.",
    z
      .object({
        account_id: account,
        file: z
          .object({
            download_url: z.string().url(),
            file_id: z.string().min(1).max(500),
            mime_type: z.string().max(200).optional(),
            file_name: z.string().max(200).optional(),
          })
          .strict(),
      })
      .strict(),
    false,
    async (p, i) => {
      await s.account(p, i.account_id, "mail.write");
      const u = new URL(i.file.download_url);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        !(s.features.hostFileOrigins ?? []).includes(u.origin)
      )
        throw new MailError("HOST_FILE_ORIGIN_DENIED", 403);
      const r = await httpClient({ privateEndpoints: [] })(u.href, {
        maxBytes: 5 * 1024 * 1024,
      });
      if (r.status !== 200)
        throw new MailError("HOST_FILE_DOWNLOAD_FAILED", 502);
      return s.upload(
        p,
        i.account_id,
        i.file.file_name ?? "attachment",
        i.file.mime_type ?? "application/octet-stream",
        r.body,
      );
    },
  );
  t.at(-1)!.fileParams = ["file"];
  add(
    "attachments_index",
    "Explicitly retain extracted text for one selected attachment in this user's private searchable index (max500/account); optional OCR requires deployment opt-in. Content untrusted, may be incomplete.",
    selected.extend({ ocr: z.boolean().default(false) }).strict(),
    false,
    async (p, i) => {
      const a = await s.attachment(
        p,
        i.account_id,
        i.message_id,
        i.attachment_id,
      );
      if (i.ocr && !s.features.ocr)
        throw new MailError("OCR_NOT_CONFIGURED", 503);
      const result = await extract(
        a.content,
        a.type,
        a.name,
        i.ocr ? { ocr: s.features.ocr } : {},
      );
      if (!result.supported) throw new MailError("EXTRACTION_UNSUPPORTED", 422);
      const id = stableId(
          `${p.subject}:${i.account_id}:${i.message_id}:${i.attachment_id}`,
        ),
        data = {
          id,
          message_id: i.message_id,
          attachment_id: i.attachment_id,
          name: a.name,
          sha256: hash(a.content),
          indexedAt: new Date().toISOString(),
          ...result,
        };
      await s.store.db.transaction(async (tx) => {
        await s.store.account(p, i.account_id, tx, true);
        const rows = await tx.query<{ id: string }>(
          "SELECT id FROM documents WHERE account_id=$1 AND tenant=$2 AND owner=$3 AND kind='attachment_index'",
          [i.account_id, p.tenant, p.subject],
        );
        if (rows.rows.length >= 500 && !rows.rows.some((r) => r.id === id))
          throw new MailError("INDEX_QUOTA", 409);
        await s.store.put(p, i.account_id, "attachment_index", id, data, tx);
      });
      return { ...data, text: undefined, characters: result.text.length };
    },
  );
  add(
    "attachments_search",
    "Substring search of explicitly indexed private snapshots, including Chinese. Stale/partial index; not semantic or full mailbox search.",
    z
      .object({
        account_id: account,
        query: z.string().min(1).max(2000),
        offset: z.number().int().min(0).max(500).default(0),
      })
      .strict(),
    true,
    async (p, i) => {
      await s.account(p, i.account_id);
      const rows = await s.store.db.query<{ data: any }>(
        "SELECT data FROM documents WHERE account_id=$1 AND tenant=$2 AND owner=$3 AND kind='attachment_index' AND strpos(lower(data->>'text'),lower($4))>0 ORDER BY id LIMIT 51 OFFSET $5",
        [i.account_id, p.tenant, p.subject, i.query, i.offset],
      );
      return {
        items: rows.rows.slice(0, 50).map((r) => {
          const start = Math.max(
            0,
            r.data.text.toLowerCase().indexOf(i.query.toLowerCase()) - 100,
          );
          return { ...r.data, text: r.data.text.slice(start, start + 1000) };
        }),
        next_offset: rows.rows.length > 50 ? i.offset + 50 : null,
        coverage: "explicitly-indexed-private-snapshots",
      };
    },
  );
  add(
    "attachments_unindex",
    "Delete this user's selected index snapshot.",
    z.object({ account_id: account, index_id: account }).strict(),
    false,
    async (p, i) => {
      await s.account(p, i.account_id);
      await s.store.db.query(
        "DELETE FROM documents WHERE id=$1 AND account_id=$2 AND tenant=$3 AND owner=$4 AND kind='attachment_index'",
        [i.index_id, i.account_id, p.tenant, p.subject],
      );
      return { deleted: true };
    },
  );
  return t;
}
