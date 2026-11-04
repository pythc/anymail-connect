import {
  MailError,
  baseCapabilities,
  type MailProvider,
  type Search,
  type Page,
  type Message,
  type DraftContent,
  type OutgoingAttachment,
  type Mutation,
} from "../domain.js";
import { Rest, enc } from "./rest.js";
import { people } from "./contacts.js";
import { draftSchema } from "../domain.js";
import addressparser from "nodemailer/lib/addressparser";
import { convert } from "html-to-text";
import iconv from "iconv-lite";
import MailComposer from "nodemailer/lib/mail-composer";
export async function compose(
  from: string,
  d: DraftContent,
  attachments: OutgoingAttachment[],
  intent: string,
  keepBcc = true,
) {
  const message = new MailComposer({
    from,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    text: d.text,
    html: d.html,
    inReplyTo: d.inReplyTo,
    references: d.references,
    messageId: `<${intent}@anymail.invalid>`,
    attachments,
  }).compile();
  message.keepBcc = keepBcc;
  return message.build();
}
function parts(node: any): any[] {
  return [node, ...(node.parts ?? []).flatMap(parts)];
}
export function gmailMessage(m: any): Message {
  const headers = Object.fromEntries(
    (m.payload?.headers ?? []).map((h: any) => [
      String(h.name).toLowerCase(),
      String(h.value),
    ]),
  ) as Record<string, string>;
  const warnings: string[] = [];
  const p = parts(m.payload ?? {}),
    decode = (type: string) =>
      p
        .filter((x) => !x.filename && x.mimeType === type && x.body?.data)
        .map((x) => {
          const value =
            (x.headers ?? []).find(
              (h: any) => String(h.name).toLowerCase() === "content-type",
            )?.value ?? "";
          const charset =
            /charset\s*=\s*["']?([^;\s"']+)/i.exec(value)?.[1] ?? "utf-8";
          const bytes = Buffer.from(x.body.data, "base64url");
          if (Boolean(iconv.encodingExists(charset)))
            return iconv.decode(bytes, charset);
          try {
            return new TextDecoder(charset).decode(bytes);
          } catch {
            warnings.push(
              `UNSUPPORTED_CHARSET:${charset.slice(0, 80)}; UTF-8 replacement fallback`,
            );
            return bytes.toString("utf8");
          }
        })
        .join("\n");
  const addresses = (v = "") =>
    addressparser(v, { flatten: true })
      .map((a) => ("address" in a ? a.address : ""))
      .filter(Boolean);
  const html = decode("text/html");
  return {
    id: m.id,
    subject: headers.subject ?? "",
    from: headers.from ?? "",
    to: addresses(headers.to),
    cc: addresses(headers.cc),
    replyTo: addresses(headers["reply-to"]),
    date: new Date(Number(m.internalDate || 0)).toISOString(),
    text:
      decode("text/plain") ||
      (html ? convert(html, { wordwrap: false }) : m.snippet || ""),
    html: html || undefined,
    read: !(m.labelIds ?? []).includes("UNREAD"),
    messageId: headers["message-id"],
    references: headers.references?.match(/<[^>]+>/g) ?? [],
    threadId: m.threadId,
    threadSource: "provider",
    labels: m.labelIds ?? [],
    headers,
    ...(warnings.length ? { warnings } : {}),
    attachments: p.flatMap((x, index) =>
      x.filename && (x.body?.attachmentId || x.body?.data !== undefined)
        ? [
            {
              id: x.body.attachmentId || `part:${index}`,
              name: x.filename,
              type: x.mimeType,
              size: x.body.size,
            },
          ]
        : [],
    ),
  };
}
export class GmailProvider implements MailProvider {
  capabilities = {
    ...baseCapabilities,
    labels: "native" as const,
    threads: "native" as const,
    nativeDrafts: "native" as const,
  };
  constructor(
    public api: Rest,
    private email: string,
    private contactsApi?: Rest,
  ) {
    if (contactsApi)
      this.capabilities = { ...this.capabilities, contacts: "native" };
  }
  async verify() {
    const r = await this.api.call("/users/me/profile");
    return { email: r.emailAddress };
  }
  async subscribe(o: { topic?: string }) {
    if (!o.topic) throw new MailError("GMAIL_PUSH_NOT_CONFIGURED", 503);
    const r = await this.api.call("/users/me/watch", "POST", {
      topicName: o.topic,
    });
    const expiration = Number(r.expiration);
    if (!Number.isFinite(expiration) || expiration <= Date.now())
      throw new MailError("INVALID_SUBSCRIPTION_RESPONSE", 502);
    return { id: this.email, expiresAt: new Date(expiration).toISOString() };
  }
  async unsubscribe() {
    await this.api.call("/users/me/stop", "POST");
  }
  async search(s: Search): Promise<Page<Message>> {
    const q = [
      s.query,
      s.from && `from:(${s.from})`,
      s.subject && `subject:(${s.subject})`,
      s.after && `after:${s.after}`,
      s.before && `before:${s.before}`,
      s.unread === true ? "is:unread" : s.unread === false ? "is:read" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const params = new URLSearchParams({
      q,
      maxResults: String(s.limit),
      ...(s.cursor ? { pageToken: s.cursor } : {}),
      ...(s.folder ? { labelIds: s.folder } : {}),
    });
    const r = await this.api.call(`/users/me/messages?${params}`);
    const items = await Promise.all(
      (r.messages ?? []).map((m: any) => this.get(m.id)),
    );
    return { items, cursor: r.nextPageToken, coverage: "provider-search" };
  }
  async get(id: string) {
    const m = await this.api.call(`/users/me/messages/${enc(id)}?format=full`);
    // Gmail can store a large body part separately, even when it is not a file.
    for (const p of parts(m.payload ?? {})) {
      if (
        !p.filename &&
        ["text/plain", "text/html"].includes(p.mimeType) &&
        p.body?.attachmentId &&
        !p.body.data
      ) {
        const body = await this.api.call(
          `/users/me/messages/${enc(id)}/attachments/${enc(p.body.attachmentId)}`,
        );
        p.body.data = body.data;
      }
    }
    return gmailMessage(m);
  }
  async attachment(messageId: string, attachmentId: string) {
    const m = await this.api.call(
      `/users/me/messages/${enc(messageId)}?format=full`,
    );
    const part = parts(m.payload ?? {}).find(
      (x, index) =>
        x.filename &&
        (x.body?.attachmentId || `part:${index}`) === attachmentId,
    );
    if (!part || (!part.body?.attachmentId && part.body?.data === undefined))
      throw new MailError("NOT_FOUND", 404);
    const body = part.body.attachmentId
      ? await this.api.call(
          `/users/me/messages/${enc(messageId)}/attachments/${enc(part.body.attachmentId)}`,
        )
      : part.body;
    return {
      content: Buffer.from(body.data, "base64url"),
      type: part.mimeType,
      name: part.filename,
    };
  }
  async folders() {
    const r = await this.api.call("/users/me/labels");
    return r.labels.map((l: any) => ({ id: l.id, name: l.name, role: l.type }));
  }
  async mutate(id: string, m: Mutation) {
    if (m.action === "trash")
      return this.api.call(`/users/me/messages/${enc(id)}/trash`, "POST");
    const add = [...(m.add ?? [])],
      remove = [...(m.remove ?? [])];
    if (m.action === "read") remove.push("UNREAD");
    else if (m.action === "unread") add.push("UNREAD");
    else if (m.action === "star") add.push("STARRED");
    else if (m.action === "unstar") remove.push("STARRED");
    else if (m.action === "archive") remove.push("INBOX");
    else if (m.action === "move" && m.destination) {
      add.push(m.destination);
      remove.push("INBOX");
    } else if (m.action !== "labels")
      throw new MailError("UNSUPPORTED_CAPABILITY", 422);
    return this.api.call(`/users/me/messages/${enc(id)}/modify`, "POST", {
      addLabelIds: add,
      removeLabelIds: remove,
    });
  }
  async send(d: DraftContent, a: OutgoingAttachment[], intent: string) {
    const raw = await compose(this.email, d, a, intent);
    const r = await this.api.call("/users/me/messages/send", "POST", {
      raw: raw.toString("base64url"),
    });
    return {
      state: "provider_accepted" as const,
      providerId: r.id,
      sentCopy: "provider" as const,
    };
  }
  async extension(op: string, input: Record<string, unknown>) {
    if (op.startsWith("contacts.") && this.contactsApi)
      return people(this.contactsApi, op, input);
    if (op === "thread") {
      const r = await this.api.call(
        `/users/me/threads/${enc(String(input.id))}?format=full`,
      );
      return { items: r.messages.map(gmailMessage), source: "provider" };
    }
    if (op === "labels.create")
      return this.api.call("/users/me/labels", "POST", {
        name: input.name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      });
    if (op === "drafts.list")
      return this.api.call(
        "/users/me/drafts?" +
          new URLSearchParams({
            maxResults: "50",
            ...(input.cursor ? { pageToken: String(input.cursor) } : {}),
          }),
      );
    if (op === "drafts.get")
      return this.api.call(
        `/users/me/drafts/${enc(String(input.id))}?format=full`,
      );
    if (op === "drafts.create") {
      const raw = await compose(
        this.email,
        input.content as DraftContent,
        input.attachments as OutgoingAttachment[],
        String(input.intent),
      );
      return this.api.call("/users/me/drafts", "POST", {
        message: { raw: raw.toString("base64url") },
      });
    }
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
  async nativeDraft(id: string) {
    const r = await this.api.call(`/users/me/drafts/${enc(id)}?format=full`),
      m = gmailMessage(r.message);
    const bcc = addressparser(m.headers?.bcc ?? "", { flatten: true })
      .map((a) => ("address" in a ? a.address : ""))
      .filter(Boolean);
    return {
      version: String(r.message.id),
      message: m,
      content: draftSchema.parse({
        to: m.to,
        cc: m.cc ?? [],
        bcc,
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        inReplyTo: m.headers?.["in-reply-to"],
        references: m.references ?? [],
      }),
    };
  }
  async updateNativeDraft(
    id: string,
    version: string,
    content: DraftContent,
    attachments: OutgoingAttachment[],
    _replaceAttachments?: boolean,
    authorize?: () => Promise<void>,
  ) {
    await authorize?.();
    if ((await this.nativeDraft(id)).version !== version)
      throw new MailError("REVISION_CONFLICT", 409);
    const raw = await compose(
      this.email,
      content,
      attachments,
      crypto.randomUUID(),
    );
    await authorize?.();
    await this.api.call(`/users/me/drafts/${enc(id)}`, "PUT", {
      id,
      message: { raw: raw.toString("base64url") },
    });
    // Gmail exposes no documented atomic compare-and-swap on drafts.update.
  }
  async sync(checkpoint: any): Promise<import("../domain.js").SyncPage> {
    let c = checkpoint,
      reset = false;
    if (!c) {
      c = {
        phase: "full",
        historyId: (await this.api.call("/users/me/profile")).historyId,
      };
      reset = true;
    }
    if (c.phase === "full") {
      const r = await this.api.call(
        "/users/me/messages?" +
          new URLSearchParams({
            maxResults: "50",
            ...(c.page ? { pageToken: c.page } : {}),
          }),
      );
      return {
        items: await Promise.all(
          (r.messages || []).map((m: any) => this.get(m.id)),
        ),
        deleted: [],
        checkpoint: r.nextPageToken
          ? { ...c, page: r.nextPageToken }
          : { phase: "history", historyId: c.historyId },
        complete: !r.nextPageToken,
        scope: "gmail:all-mail-visible-to-token",
        reset,
      };
    }
    let r;
    try {
      r = await this.api.call(
        "/users/me/history?" +
          new URLSearchParams({
            startHistoryId: c.historyId,
            maxResults: "50",
            ...(c.page ? { pageToken: c.page } : {}),
          }),
      );
    } catch (e) {
      if (e instanceof MailError && e.status === 404)
        return this.sync(undefined);
      throw e;
    }
    const ids = new Set<string>();
    for (const h of r.history || [])
      for (const m of h.messages || []) ids.add(m.id);
    const items: Message[] = [],
      deleted: string[] = [];
    for (const mid of ids) {
      try {
        items.push(await this.get(mid));
      } catch (e) {
        if (e instanceof MailError && e.status === 404) deleted.push(mid);
        else throw e;
      }
    }
    return {
      items,
      deleted,
      checkpoint: r.nextPageToken
        ? { ...c, page: r.nextPageToken }
        : { phase: "history", historyId: r.historyId || c.historyId },
      complete: !r.nextPageToken,
      scope: "gmail:all-mail-visible-to-token",
    };
  }
}
