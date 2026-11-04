import sanitizeHtml from "sanitize-html";
import addressparser from "nodemailer/lib/addressparser";
import {
  connectionSchema,
  draftSchema,
  searchSchema,
  MailError,
  publicAccount,
  requireScope,
  type Principal,
  type Connection,
  type Account,
  type Draft,
  type DraftContent,
  type Message,
  type Mutation,
  type Search,
  type OutgoingAttachment,
} from "./domain.js";
import { Store, id } from "./store.js";
import { Vault, hash } from "./crypto.js";
import type { ProviderFactory } from "./providers/factory.js";
export type Operation = {
  id: string;
  accountId: string;
  draftId: string;
  revision: number;
  client: string;
  digest: string;
  content: DraftContent;
  sender: string;
  attachments: AttachmentManifest[];
  state:
    | "pending"
    | "approved"
    | "submitting"
    | "provider_accepted"
    | "unknown"
    | "cancelled"
    | "failed";
  expiresAt: string;
  dueAt: string;
  schedule: string;
  submittedAt?: string;
  receipt?: unknown;
  failure?: string;
};
export type AttachmentManifest = {
  id: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function intentDigest(
  op: Pick<
    Operation,
    "accountId" | "sender" | "attachments" | "draftId" | "revision" | "content"
  > & { schedule: string },
) {
  const {
    accountId,
    sender,
    attachments,
    draftId,
    revision,
    content,
    schedule,
  } = op;
  return hash(
    JSON.stringify(
      canonical({
        accountId,
        sender,
        attachments,
        draftId,
        revision,
        content,
        schedule,
      }),
    ),
  );
}
type Blob = {
  id: string;
  name: string;
  type: string;
  size: number;
  content: string;
  sha256: string;
  createdAt?: string;
};
export function cleanHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "table",
      "tr",
      "td",
      "th",
      "thead",
      "tbody",
    ],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "discard",
  });
}
export function safeMessage(m: Message) {
  const text = m.text.slice(0, 100_000),
    html = m.html ? cleanHtml(m.html).slice(0, 200_000) : undefined;
  return {
    ...m,
    text,
    html,
    truncated:
      text.length < m.text.length ||
      Boolean(m.html && html!.length < m.html.length),
  };
}
export class MailService {
  constructor(
    public store: Store,
    public vault: Vault,
    public providers: ProviderFactory,
    public baseUrl: string,
    public features: {
      ocr?: { binary: string; languages: string };
      hostFileOrigins?: string[];
      retention?: { cacheDays: number; draftDays: number; auditDays: number };
    } = {},
  ) {}
  async account(p: Principal, accountId: string, scope = "mail.read") {
    requireScope(p, scope);
    const a = await this.store.account(
      p,
      accountId,
      this.store.db,
      false,
      scope,
    );
    if (!a.verified) throw new MailError("CONNECTION_NOT_VERIFIED", 409);
    if (scope !== "mail.read" && !a.writable)
      throw new MailError("ACCOUNT_READ_ONLY", 403);
    if (scope === "mail.send" && !a.sendEnabled)
      throw new MailError("SEND_DISABLED", 403);
    return a;
  }
  async owner(p: Principal, accountId: string) {
    requireScope(p, "mail.write");
    const a = await this.store.account(p, accountId);
    if (a.owner !== p.subject) throw new MailError("OWNER_REQUIRED", 403);
    return a;
  }
  async grants(p: Principal, accountId: string) {
    await this.owner(p, accountId);
    return (
      await this.store.db.query(
        "SELECT subject,scopes,expires_at FROM account_grants WHERE account_id=$1 AND tenant=$2 ORDER BY subject",
        [accountId, p.tenant],
      )
    ).rows;
  }
  async grant(
    p: Principal,
    accountId: string,
    subject: string,
    scopes: string[],
    expiresAt: string,
  ) {
    await this.owner(p, accountId);
    if (
      !subject ||
      subject.length > 200 ||
      subject === p.subject ||
      !scopes.includes("mail.read") ||
      scopes.some(
        (s) => !["mail.read", "mail.write", "mail.send"].includes(s),
      ) ||
      (scopes.includes("mail.send") && !scopes.includes("mail.write")) ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now() ||
      Date.parse(expiresAt) > Date.now() + 366 * 86400_000
    )
      throw new MailError("INVALID_GRANT");
    await this.store.db.transaction(async (tx) => {
      const a = await this.store.account(p, accountId, tx, true);
      if (a.owner !== p.subject) throw new MailError("OWNER_REQUIRED", 403);
      const previous = await tx.query(
        "SELECT subject FROM account_grants WHERE account_id=$1 AND tenant=$2 AND subject=$3 AND expires_at>now()",
        [accountId, p.tenant, subject],
      );
      if (!scopes.includes("mail.send") || !previous.rows.length)
        await tx.query(
          "UPDATE operations SET state='cancelled',data=jsonb_set(data,'{state}','\"cancelled\"') WHERE account_id=$1 AND tenant=$2 AND owner=$3 AND state IN ('pending','approved')",
          [accountId, p.tenant, subject],
        );
      await tx.query(
        "INSERT INTO account_grants VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,subject) DO UPDATE SET scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at",
        [
          accountId,
          p.tenant,
          subject,
          JSON.stringify([...new Set(scopes)]),
          expiresAt,
        ],
      );
      await this.store.audit(p, accountId, "grant.update", subject, "ok", tx);
    });
    return { subject, scopes, expiresAt };
  }
  async revokeGrant(p: Principal, accountId: string, subject: string) {
    await this.owner(p, accountId);
    if (subject === p.subject) throw new MailError("INVALID_GRANT");
    await this.store.db.transaction(async (tx) => {
      await this.store.account(p, accountId, tx, true);
      await tx.query(
        "DELETE FROM account_grants WHERE account_id=$1 AND tenant=$2 AND subject=$3",
        [accountId, p.tenant, subject],
      );
      await tx.query(
        "UPDATE operations SET state='cancelled',data=jsonb_set(data,'{state}','\"cancelled\"') WHERE account_id=$1 AND tenant=$2 AND owner=$3 AND state IN ('pending','approved')",
        [accountId, p.tenant, subject],
      );
      await tx.query(
        "DELETE FROM documents WHERE account_id=$1 AND tenant=$2 AND owner=$3",
        [accountId, p.tenant, subject],
      );
      await this.store.audit(p, accountId, "grant.revoke", subject, "ok", tx);
    });
    return { revoked: true };
  }
  async connect(
    p: Principal,
    raw: unknown,
    writable = false,
    sendEnabled = false,
  ) {
    requireScope(p, "mail.write");
    if (sendEnabled) requireScope(p, "mail.send");
    if (sendEnabled && !writable)
      throw new MailError("SEND_REQUIRES_WRITE_POLICY");
    const c = connectionSchema.parse(raw),
      account: Account = {
        id: id(),
        tenant: p.tenant,
        owner: p.subject,
        provider: c.provider,
        email: c.email.toLowerCase(),
        writable,
        sendEnabled,
        revoked: false,
        verified: false,
        secret: "",
        createdAt: new Date().toISOString(),
      };
    account.secret = this.vault.seal(
      c,
      `${account.tenant}:${account.owner}:${account.id}`,
    );
    // A provisional factory must not refresh before the account exists.
    if (
      (c.provider === "gmail" || c.provider === "graph") &&
      c.oauth.expiresAt &&
      c.oauth.expiresAt < Date.now() + 60_000
    )
      throw new MailError("PROVIDER_AUTH_REQUIRED", 401);
    await this.store.addAccount(account);
    try {
      const identity = await (await this.providers(account)).verify();
      if (identity.email.toLowerCase() !== account.email)
        throw new MailError("EMAIL_IDENTITY_MISMATCH", 403);
      await this.store.db.transaction(async (tx) => {
        const current = await this.store.account(p, account.id, tx, true);
        current.verified = true;
        await this.store.updateAccount(current, tx);
      });
      account.verified = true;
    } catch (e) {
      await this.store.db.query("DELETE FROM accounts WHERE id=$1", [
        account.id,
      ]);
      throw e;
    }
    await this.store.audit(p, account.id, "account.connect", account.id, "ok");
    return publicAccount(account);
  }
  async revoke(p: Principal, accountId: string) {
    requireScope(p, "mail.write");
    await this.owner(p, accountId);
    await this.store.db.transaction(async (tx) => {
      const a = await this.store.account(p, accountId, tx, true);
      a.revoked = true;
      a.secret = "";
      await this.store.updateAccount(a, tx);
      await tx.query(
        "UPDATE operations SET state='cancelled',data=jsonb_set(data,'{state}','\"cancelled\"') WHERE account_id=$1 AND tenant=$2 AND state IN ('pending','approved')",
        [accountId, p.tenant],
      );
      await tx.query(
        "DELETE FROM documents WHERE account_id=$1 AND tenant=$2",
        [accountId, p.tenant],
      );
      await tx.query("DELETE FROM account_grants WHERE account_id=$1", [
        accountId,
      ]);
      await tx.query(
        "DELETE FROM change_requests WHERE account_id=$1 AND tenant=$2 AND owner=$3",
        [accountId, p.tenant, p.subject],
      );
      await this.store.audit(
        p,
        accountId,
        "account.revoke",
        accountId,
        "ok",
        tx,
      );
    });
  }
  async search(p: Principal, accountId: string, raw: unknown) {
    const a = await this.account(p, accountId),
      s = searchSchema.parse(raw),
      page = await (await this.providers(a)).search(s);
    return {
      ...page,
      items: page.items.map((m) => ({
        ...safeMessage(m),
        text: m.text.slice(0, 1500),
        html: undefined,
        truncated: m.text.length > 1500 || Boolean(m.html),
        source_url: this.source(accountId, m.id),
      })),
      observed_at: new Date().toISOString(),
    };
  }
  source(accountId: string, messageId: string) {
    return `${this.baseUrl}/message/${accountId}/${encodeURIComponent(messageId)}`;
  }
  async get(p: Principal, accountId: string, messageId: string) {
    const a = await this.account(p, accountId);
    return {
      ...safeMessage(await (await this.providers(a)).get(messageId)),
      source_url: this.source(accountId, messageId),
      observed_at: new Date().toISOString(),
    };
  }
  async attachment(
    p: Principal,
    accountId: string,
    messageId: string,
    attachmentId: string,
  ) {
    const a = await this.account(p, accountId);
    const result = await (
      await this.providers(a)
    ).attachment(messageId, attachmentId);
    if (result.content.length > 8 * 1024 * 1024)
      throw new MailError("ATTACHMENT_TOO_LARGE", 413);
    return result;
  }
  async upload(
    p: Principal,
    accountId: string,
    name: string,
    type: string,
    bytes: Buffer,
  ) {
    await this.account(p, accountId, "mail.write");
    if (
      !name ||
      name.length > 200 ||
      /[\r\n\x00]/.test(name) ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(type)
    )
      throw new MailError("INVALID_ATTACHMENT");
    if (bytes.length > 5 * 1024 * 1024)
      throw new MailError("ATTACHMENT_TOO_LARGE", 413);
    const blob: Blob = {
      id: id(),
      name,
      type,
      size: bytes.length,
      content: bytes.toString("base64"),
      sha256: hash(bytes),
      createdAt: new Date().toISOString(),
    };
    await this.store.put(p, accountId, "blob", blob.id, blob);
    return { id: blob.id, name, type, size: blob.size, sha256: blob.sha256 };
  }
  async uploaded(p: Principal, accountId: string, blobId: string) {
    await this.account(p, accountId);
    const b = await this.store.get<Blob>(p, accountId, "blob", blobId);
    return {
      content: Buffer.from(b.content, "base64"),
      name: b.name,
      type: b.type,
    };
  }
  private async manifest(
    p: Principal,
    accountId: string,
    content: DraftContent,
    tx: import("./db.js").Queryable = this.store.db,
  ): Promise<AttachmentManifest[]> {
    const items: AttachmentManifest[] = [];
    for (const id of content.attachmentIds) {
      const b = await this.store.get<Blob>(p, accountId, "blob", id, tx);
      // Compute the identity of the bytes that will actually be submitted.
      items.push({
        id,
        name: b.name,
        type: b.type,
        size: Buffer.from(b.content, "base64").length,
        sha256: hash(Buffer.from(b.content, "base64")),
      });
    }
    return items;
  }
  private async checkIntent(
    p: Principal,
    op: Operation,
    a: Account,
    d: Draft,
    tx: import("./db.js").Queryable,
  ) {
    if (
      !op.sender ||
      !op.schedule ||
      (op.schedule !== "immediate" && op.schedule !== op.dueAt) ||
      !Array.isArray(op.attachments) ||
      op.sender !== a.email ||
      op.accountId !== d.accountId ||
      op.revision !== d.revision
    )
      throw new MailError("APPROVAL_BINDING_CHANGED", 409);
    const current = {
      ...op,
      sender: a.email,
      content: d.content,
      attachments: await this.manifest(p, a.id, d.content, tx),
    };
    if (intentDigest(op) !== op.digest || intentDigest(current) !== op.digest)
      throw new MailError("APPROVAL_BINDING_CHANGED", 409);
  }
  private async attachments(
    p: Principal,
    accountId: string,
    content: DraftContent,
  ): Promise<OutgoingAttachment[]> {
    let size = 0;
    const items: OutgoingAttachment[] = [];
    for (const blobId of content.attachmentIds) {
      const b = await this.store.get<Blob>(p, accountId, "blob", blobId);
      size += b.size;
      if (size > 8 * 1024 * 1024)
        throw new MailError("ATTACHMENTS_TOO_LARGE", 413);
      items.push({
        filename: b.name,
        contentType: b.type,
        content: Buffer.from(b.content, "base64"),
      });
    }
    return items;
  }
  private async validateContent(p: Principal, accountId: string, raw: unknown) {
    const content = draftSchema.parse(raw);
    if (content.html) content.html = cleanHtml(content.html);
    await this.attachments(p, accountId, content);
    return content;
  }
  async createDraft(p: Principal, accountId: string, raw: unknown) {
    await this.account(p, accountId, "mail.write");
    const content = await this.validateContent(p, accountId, raw);
    const draft: Draft = {
      id: id(),
      accountId,
      revision: 1,
      content,
      updatedAt: new Date().toISOString(),
      storage: "application",
    };
    await this.store.put(p, accountId, "draft", draft.id, draft);
    await this.store.audit(p, accountId, "draft.create", draft.id, "ok");
    return draft;
  }
  async exportDraft(
    p: Principal,
    accountId: string,
    draftId: string,
    revision: number,
  ) {
    const a = await this.account(p, accountId, "mail.write"),
      d = await this.store.get<Draft>(p, accountId, "draft", draftId);
    if (d.revision !== revision) throw new MailError("REVISION_CONFLICT", 409);
    const provider = await this.providers(a);
    if (provider.capabilities.nativeDrafts !== "native" || !provider.extension)
      throw new MailError("UNSUPPORTED_CAPABILITY", 422);
    const result = await provider.extension("drafts.create", {
      content: d.content,
      attachments: await this.attachments(p, accountId, d.content),
      intent: d.id,
    });
    await this.store.audit(p, accountId, "draft.export", draftId, "ok");
    return {
      provider_draft: result,
      storage: "provider",
      note: "Independent copy. Later app edits do not automatically overwrite it. Never automatically retry an uncertain export.",
    };
  }
  async updateDraft(
    p: Principal,
    accountId: string,
    draftId: string,
    revision: number,
    raw: unknown,
  ) {
    await this.account(p, accountId, "mail.write");
    const content = await this.validateContent(p, accountId, raw);
    return this.store.db.transaction(async (tx) => {
      await this.store.account(p, accountId, tx, true);
      const d = await this.store.get<Draft>(
        p,
        accountId,
        "draft",
        draftId,
        tx,
        true,
      );
      if (d.revision !== revision)
        throw new MailError("REVISION_CONFLICT", 409);
      d.content = content;
      d.revision++;
      d.updatedAt = new Date().toISOString();
      await this.store.put(p, accountId, "draft", d.id, d, tx);
      return d;
    });
  }
  async reply(
    p: Principal,
    accountId: string,
    messageId: string,
    text: string,
    mode: "reply" | "reply_all" | "forward",
    to: string[] = [],
    sourceAttachmentIds: string[] = [],
  ) {
    const a = await this.account(p, accountId, "mail.write"),
      m = await this.get(p, accountId, messageId);
    const parse = (values: string[]) =>
      values
        .flatMap((v) =>
          addressparser(v, { flatten: true }).map((a) =>
            "address" in a ? a.address : "",
          ),
        )
        .filter(Boolean);
    const targets =
      mode === "forward" ? to : parse(m.replyTo?.length ? m.replyTo : [m.from]);
    const cc = mode === "reply_all" ? parse([...m.to, ...(m.cc ?? [])]) : [];
    const unique = (values: string[]) =>
      [...new Set(values.map((s) => s.toLowerCase()))].filter(
        (s) => s !== a.email.toLowerCase(),
      );
    const subject = /^(re|fwd?):/i.test(m.subject)
      ? m.subject
      : `${mode === "forward" ? "Fwd" : "Re"}: ${m.subject}`;
    const selected = [...new Set(sourceAttachmentIds)];
    if (selected.length > 20) throw new MailError("ATTACHMENTS_TOO_LARGE", 413);
    if (selected.some((id) => !m.attachments.some((a) => a.id === id)))
      throw new MailError("NOT_FOUND", 404);
    // Fetch and validate all selected bytes before writing any attachment copy.
    const copies = [];
    let total = 0;
    for (const attachmentId of selected) {
      const source = await this.attachment(
        p,
        accountId,
        messageId,
        attachmentId,
      );
      total += source.content.length;
      if (source.content.length > 5 * 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new MailError("ATTACHMENTS_TOO_LARGE", 413);
      copies.push(source);
    }
    const attachmentIds = [];
    for (const source of copies)
      attachmentIds.push(
        (
          await this.upload(
            p,
            accountId,
            source.name,
            source.type,
            source.content,
          )
        ).id,
      );
    return this.createDraft(p, accountId, {
      to: unique(targets),
      cc: unique(cc).filter((x) => !unique(targets).includes(x)),
      bcc: [],
      subject,
      text: `${text}\n\n--- ${m.date} ${m.from} ---\n${m.text}`,
      attachmentIds,
      references:
        mode === "forward"
          ? []
          : [
              ...(m.references ?? []),
              ...(m.messageId ? [m.messageId] : []),
            ].slice(-100),
      ...(mode !== "forward" && m.messageId ? { inReplyTo: m.messageId } : {}),
    });
  }
  async prepare(
    p: Principal,
    accountId: string,
    draftId: string,
    revision: number,
    dedupe: string,
    dueAt?: string,
  ) {
    const account = await this.account(p, accountId, "mail.send");
    if (!dedupe || dedupe.length > 200)
      throw new MailError("INVALID_IDEMPOTENCY_KEY");
    const due = dueAt ? Date.parse(dueAt) : Date.now();
    if (!Number.isFinite(due) || due > Date.now() + 30 * 86400_000)
      throw new MailError("INVALID_SCHEDULE");
    const d = await this.store.get<Draft>(p, accountId, "draft", draftId);
    if (d.revision !== revision) throw new MailError("REVISION_CONFLICT", 409);
    if (![...d.content.to, ...d.content.cc, ...d.content.bcc].length)
      throw new MailError("RECIPIENT_REQUIRED");
    const binding = {
      accountId,
      sender: account.email,
      attachments: await this.manifest(p, accountId, d.content),
      draftId,
      revision,
      content: d.content,
      schedule: dueAt ? new Date(due).toISOString() : "immediate",
    };
    const digest = intentDigest(binding);
    const op: Operation = {
      id: id(),
      accountId,
      draftId,
      revision,
      client: p.client,
      digest,
      content: d.content,
      schedule: binding.schedule,
      sender: binding.sender,
      attachments: binding.attachments,
      state: "pending",
      dueAt: new Date(due).toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const existing = await this.store.db.transaction(async (tx) => {
      const current = await this.store.account(
        p,
        accountId,
        tx,
        true,
        "mail.send",
      );
      if (!current.writable || !current.sendEnabled)
        throw new MailError("SEND_DISABLED", 403);
      await tx.query(
        "INSERT INTO operations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant,owner,account_id,dedupe) DO NOTHING",
        [
          op.id,
          p.tenant,
          p.subject,
          accountId,
          p.client,
          dedupe,
          op.state,
          op.dueAt,
          JSON.stringify(op),
        ],
      );
      return (
        await tx.query<{ data: Operation }>(
          "SELECT data FROM operations WHERE tenant=$1 AND owner=$2 AND account_id=$3 AND dedupe=$4",
          [p.tenant, p.subject, accountId, dedupe],
        )
      ).rows[0]!.data;
    });
    if (existing.digest !== digest || existing.client !== p.client)
      throw new MailError("IDEMPOTENCY_CONFLICT", 409);
    return {
      ...existing,
      approval_url: `${this.baseUrl}/approve/${existing.id}`,
    };
  }
  async operation(
    p: Principal,
    operationId: string,
    tx = this.store.db as import("./db.js").Queryable,
    lock = false,
  ): Promise<Operation> {
    requireScope(p, "mail.read");
    const r = await tx.query<{ data: Operation }>(
      "SELECT data FROM operations WHERE tenant=$1 AND owner=$2 AND id=$3" +
        (lock ? " FOR UPDATE" : ""),
      [p.tenant, p.subject, operationId],
    );
    if (!r.rows[0]) throw new MailError("NOT_FOUND", 404);
    return r.rows[0].data;
  }
  private async saveOperation(
    p: Principal,
    op: Operation,
    tx: import("./db.js").Queryable = this.store.db,
  ) {
    await tx.query(
      "UPDATE operations SET state=$4,data=$5 WHERE tenant=$1 AND owner=$2 AND id=$3",
      [p.tenant, p.subject, op.id, op.state, JSON.stringify(op)],
    );
  }
  // Only call from a server-side authenticated browser session after CSRF validation.
  async approve(p: Principal, operationId: string, digest: string) {
    requireScope(p, "mail.send");
    return this.store.db.transaction(async (tx) => {
      const initial = await this.operation(p, operationId, tx);
      const a = await this.store.account(
        p,
        initial.accountId,
        tx,
        true,
        "mail.send",
      );
      const op = await this.operation(p, operationId, tx, true);
      if (
        op.state !== "pending" ||
        op.digest !== digest ||
        Date.parse(op.expiresAt) < Date.now()
      )
        throw new MailError("APPROVAL_INVALID", 409);
      if (!a.writable || !a.sendEnabled)
        throw new MailError("SEND_DISABLED", 403);
      const d = await this.store.get<Draft>(p, a.id, "draft", op.draftId, tx);
      if (d.revision !== op.revision)
        throw new MailError("REVISION_CONFLICT", 409);
      await this.checkIntent(p, op, a, d, tx);
      op.state = "approved";
      await this.saveOperation(p, op, tx);
      await this.store.audit(p, a.id, "send.approve", op.id, "approved", tx);
      return op;
    });
  }
  async cancel(p: Principal, operationId: string) {
    requireScope(p, "mail.send");
    return this.store.db.transaction(async (tx) => {
      const op = await this.operation(p, operationId, tx, true);
      if (!["pending", "approved"].includes(op.state))
        throw new MailError("ALREADY_SUBMITTED", 409);
      op.state = "cancelled";
      await this.saveOperation(p, op, tx);
      return op;
    });
  }
  async submit(p: Principal, operationId: string, worker = false) {
    requireScope(p, "mail.send");
    const op = await this.store.db.transaction(async (tx) => {
      const initial = await this.operation(p, operationId, tx);
      const a = await this.store.account(
        p,
        initial.accountId,
        tx,
        true,
        "mail.send",
      );
      const o = await this.operation(p, operationId, tx, true);
      if (!worker && o.client !== p.client)
        throw new MailError("CLIENT_MISMATCH", 403);
      if (o.state !== "approved") {
        if (
          [
            "provider_accepted",
            "unknown",
            "failed",
            "cancelled",
            "submitting",
          ].includes(o.state)
        )
          return o;
        throw new MailError("USER_APPROVAL_REQUIRED", 403);
      }
      if (Date.parse(o.dueAt) > Date.now()) return o;
      if (!a.writable || !a.sendEnabled)
        throw new MailError("SEND_DISABLED", 403);
      const d = await this.store.get<Draft>(
        p,
        a.id,
        "draft",
        o.draftId,
        tx,
        true,
      );
      if (d.revision !== o.revision) {
        o.state = "failed";
        o.failure = "REVISION_CONFLICT";
        await this.saveOperation(p, o, tx);
        return o;
      }
      try {
        await this.checkIntent(p, o, a, d, tx);
      } catch (e) {
        if (!(e instanceof MailError)) throw e;
        o.state = "failed";
        o.failure = e.code;
        await this.saveOperation(p, o, tx);
        return o;
      }
      o.state = "submitting";
      o.submittedAt = new Date().toISOString();
      await this.saveOperation(p, o, tx);
      return { ...o, claimed: true };
    });
    if (!("claimed" in op)) return op;
    let result: Operation;
    try {
      const account = await this.account(p, op.accountId, "mail.send"),
        attachments = await this.attachments(p, op.accountId, op.content);
      const receipt = await (
        await this.providers(account)
      ).send(op.content, attachments, op.id);
      result = { ...op, state: "provider_accepted", receipt };
    } catch {
      result = { ...op, state: "unknown", failure: "SEND_STATUS_UNKNOWN" };
    }
    delete (result as any).claimed;
    await this.saveOperation(p, result);
    await this.store.audit(
      p,
      result.accountId,
      "send.submit",
      result.id,
      result.state,
    );
    return result;
  }
  async tick(signal?: AbortSignal) {
    // A crash at the external submission boundary cannot safely be retried.
    await this.store.db.query(
      "UPDATE operations SET state='unknown',data=jsonb_set(jsonb_set(data,'{state}','\"unknown\"'),'{failure}','\"SEND_STATUS_UNKNOWN\"') WHERE state='submitting' AND (data->>'submittedAt')::timestamptz < now()-interval '2 minutes'",
    );
    const rows = await this.store.db.query<{
      tenant: string;
      owner: string;
      client: string;
      id: string;
    }>(
      "SELECT tenant,owner,client,id FROM operations WHERE state='approved' AND due_at<=now() ORDER BY due_at LIMIT 20",
    );
    for (const row of rows.rows) {
      if (signal?.aborted) break;
      const p = {
        tenant: row.tenant,
        subject: row.owner,
        client: row.client,
        scopes: ["mail.read", "mail.write", "mail.send"],
      };
      try {
        await this.submit(p, row.id, true);
      } catch (e) {
        await this.store.audit(
          p,
          null,
          "worker.send",
          row.id,
          e instanceof MailError ? e.code : "ERROR",
        );
      }
    }
    await this.store.db.query("DELETE FROM sessions WHERE expires_at<now()");
  }
  async mutate(
    p: Principal,
    accountId: string,
    messageId: string,
    mutation: Mutation,
  ) {
    const a = await this.account(p, accountId, "mail.write");
    const result = await (await this.providers(a)).mutate(messageId, mutation);
    await this.store.audit(
      p,
      a.id,
      "message." + mutation.action,
      hash(messageId),
      "ok",
    );
    return result;
  }
  async batch(
    p: Principal,
    accountId: string,
    messageIds: string[],
    mutation?: Mutation,
  ) {
    if (messageIds.length > 50) throw new MailError("BATCH_TOO_LARGE");
    const result = [];
    for (const mid of [...new Set(messageIds)]) {
      try {
        result.push({
          id: mid,
          ok: true,
          result: mutation
            ? await this.mutate(p, accountId, mid, mutation)
            : await this.get(p, accountId, mid),
        });
      } catch (e) {
        result.push({
          id: mid,
          ok: false,
          error: e instanceof MailError ? e.code : "PROVIDER_ERROR",
        });
      }
    }
    return { items: result, partial_failure: result.some((x) => !x.ok) };
  }
  async extension(
    p: Principal,
    accountId: string,
    op: string,
    input: Record<string, unknown>,
  ) {
    const write = /\.(create|update|delete)$/.test(op);
    const a = await this.account(
      p,
      accountId,
      write ? "mail.write" : "mail.read",
    );
    const provider = await this.providers(a);
    if (!provider.extension) throw new MailError("UNSUPPORTED_CAPABILITY", 422);
    const result = await provider.extension(op, input);
    if (write) await this.store.audit(p, a.id, op, null, "ok");
    return result;
  }
  async unsubscribe(p: Principal, accountId: string, messageId: string) {
    const m = await this.get(p, accountId, messageId),
      header = m.headers?.["list-unsubscribe"] ?? "";
    const links = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    return {
      targets: links.filter((x) => /^(mailto:|https:\/\/)/i.test(x)),
      one_click_header: m.headers?.["list-unsubscribe-post"] ?? null,
      automatic_requests: false,
    };
  }
}
