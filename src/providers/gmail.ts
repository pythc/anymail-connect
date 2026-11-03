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
  const p = parts(m.payload ?? {}),
    decode = (type: string) =>
      p
        .filter((x) => x.mimeType === type && x.body?.data)
        .map((x) => Buffer.from(x.body.data, "base64url").toString())
        .join("\n");
  return {
    id: m.id,
    subject: headers.subject ?? "",
    from: headers.from ?? "",
    to: (headers.to ?? "").split(",").filter(Boolean),
    date: new Date(Number(m.internalDate || 0)).toISOString(),
    text: decode("text/plain") || m.snippet || "",
    html: decode("text/html") || undefined,
    read: !(m.labelIds ?? []).includes("UNREAD"),
    messageId: headers["message-id"],
    references: headers.references?.match(/<[^>]+>/g) ?? [],
    threadId: m.threadId,
    threadSource: "provider",
    labels: m.labelIds ?? [],
    headers,
    attachments: p
      .filter((x) => x.filename && x.body?.attachmentId)
      .map((x) => ({
        id: x.body.attachmentId,
        name: x.filename,
        type: x.mimeType,
        size: x.body.size,
      })),
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
  ) {}
  async verify() {
    const r = await this.api.call("/users/me/profile");
    return { email: r.emailAddress };
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
    return gmailMessage(
      await this.api.call(`/users/me/messages/${enc(id)}?format=full`),
    );
  }
  async attachment(messageId: string, attachmentId: string) {
    const m = await this.get(messageId),
      a = m.attachments.find((x) => x.id === attachmentId);
    if (!a) throw new MailError("NOT_FOUND", 404);
    const r = await this.api.call(
      `/users/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
    );
    return {
      content: Buffer.from(r.data, "base64url"),
      type: a.type,
      name: a.name,
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
