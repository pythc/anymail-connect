import {
  baseCapabilities,
  MailError,
  type MailProvider,
  type Connection,
  type Search,
  type Message,
  type DraftContent,
  type OutgoingAttachment,
  type Mutation,
} from "../domain.js";
import { type HttpRequest, providerError } from "../network.js";
import { compose } from "./gmail.js";
import { cursorDecode, cursorEncode } from "./rest.js";
type Config = Extract<Connection, { provider: "jmap" }>;
export class JmapProvider implements MailProvider {
  capabilities = { ...baseCapabilities, threads: "native" as const };
  private sessionData?: any;
  constructor(
    private config: Config,
    private http: HttpRequest,
    private allowedOrigins: string[] = [],
  ) {}
  private checked(url: string) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      (target.origin !== new URL(this.config.sessionUrl).origin &&
        !this.allowedOrigins.includes(target.origin))
    )
      throw new MailError("JMAP_CROSS_ORIGIN_DENIED", 403);
    return url;
  }
  private async session() {
    if (!this.sessionData) {
      const r = await this.http(this.config.sessionUrl, {
        headers: { authorization: `Bearer ${this.config.token}` },
      });
      if (r.status !== 200) providerError(r.status, r.headers);
      this.sessionData = JSON.parse(r.body.toString());
      this.checked(this.sessionData.apiUrl);
    }
    return this.sessionData;
  }
  private async call(method: string, args: Record<string, unknown>) {
    const s = await this.session(),
      accountId = s.primaryAccounts["urn:ietf:params:jmap:mail"];
    const using = [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      ...(method.startsWith("EmailSubmission") || method.startsWith("Identity")
        ? ["urn:ietf:params:jmap:submission"]
        : []),
    ];
    const r = await this.http(this.checked(s.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        using,
        methodCalls: [[method, { accountId, ...args }, "0"]],
      }),
    });
    if (r.status !== 200) providerError(r.status, r.headers);
    const response = JSON.parse(r.body.toString()).methodResponses?.[0];
    if (!response || response[0] === "error")
      throw new MailError("JMAP_METHOD_ERROR", 502, {
        type: response?.[1]?.type,
      });
    const result = response[1];
    if (result.notCreated && Object.keys(result.notCreated).length)
      throw new MailError("JMAP_CREATE_FAILED", 502);
    return result;
  }
  async verify() {
    const s = await this.session();
    return { email: s.username };
  }
  private map(m: any): Message {
    const messageId = (v: string) => `<${v.replace(/^<|>$/g, "")}>`;
    const vals = Object.values(m.bodyValues ?? {}) as any[];
    return {
      id: m.id,
      subject: m.subject || "",
      from: m.from?.[0]?.email || "",
      to: (m.to || []).map((a: any) => a.email),
      cc: (m.cc || []).map((a: any) => a.email),
      replyTo: (m.replyTo || []).map((a: any) => a.email),
      date: m.receivedAt,
      text: vals.map((x) => x.value).join("\n"),
      read: Boolean(m.keywords?.["$seen"]),
      messageId: m.messageId?.[0] ? messageId(m.messageId[0]) : undefined,
      references: (m.references ?? []).map(messageId),
      threadId: m.threadId,
      threadSource: "provider",
      attachments: (m.attachments || []).map((a: any) => ({
        id: a.blobId,
        name: a.name || "attachment",
        type: a.type,
        size: a.size,
      })),
    };
  }
  async search(q: Search) {
    if (q.folder === "INBOX") {
      const folder = (await this.folders()).find(
        (f: any) => f.role === "inbox",
      );
      if (!folder) throw new MailError("INBOX_NOT_FOUND", 404);
      q = { ...q, folder: folder.id };
    }
    const position = q.cursor
      ? cursorDecode<{ position: number }>(q.cursor).position
      : 0;
    if (!Number.isSafeInteger(position) || position < 0)
      throw new MailError("INVALID_CURSOR");
    const filter = {
      ...(q.query ? { text: q.query } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
      ...(q.after ? { after: `${q.after}T00:00:00Z` } : {}),
      ...(q.before ? { before: `${q.before}T00:00:00Z` } : {}),
      ...(q.folder ? { inMailbox: q.folder } : {}),
      ...(q.unread === true
        ? { notKeyword: "$seen" }
        : q.unread === false
          ? { hasKeyword: "$seen" }
          : {}),
    };
    const r = await this.call("Email/query", {
      filter,
      sort: [{ property: "receivedAt", isAscending: false }],
      position,
      limit: q.limit,
      calculateTotal: true,
    });
    const m = r.ids.length
      ? await this.call("Email/get", {
          ids: r.ids,
          fetchTextBodyValues: true,
          maxBodyValueBytes: 100_000,
        })
      : { list: [] };
    return {
      items: m.list.map((x: any) => this.map(x)),
      cursor:
        position + r.ids.length < r.total
          ? cursorEncode({ position: position + r.ids.length })
          : undefined,
      coverage: "provider-search",
    };
  }
  async get(id: string) {
    const r = await this.call("Email/get", {
      ids: [id],
      fetchAllBodyValues: true,
      maxBodyValueBytes: 500_000,
    });
    if (!r.list[0]) throw new MailError("NOT_FOUND", 404);
    return this.map(r.list[0]);
  }
  async attachment(messageId: string, attachmentId: string) {
    const m = await this.get(messageId),
      a = m.attachments.find((x) => x.id === attachmentId);
    if (!a) throw new MailError("NOT_FOUND", 404);
    const s = await this.session(),
      accountId = s.primaryAccounts["urn:ietf:params:jmap:mail"];
    const url = s.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(attachmentId))
      .replace("{name}", encodeURIComponent(a.name))
      .replace("{type}", encodeURIComponent(a.type));
    const r = await this.http(this.checked(url), {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    if (r.status !== 200) providerError(r.status);
    return { content: r.body, name: a.name, type: a.type };
  }
  async folders() {
    const r = await this.call("Mailbox/get", {});
    return r.list.map((f: any) => ({
      id: f.id,
      name: f.name,
      role: f.role,
      count: f.totalEmails,
      unread: f.unreadEmails,
    }));
  }
  async mutate(id: string, m: Mutation) {
    let patch: Record<string, unknown> = {};
    if (["read", "unread", "star", "unstar"].includes(m.action))
      patch = {
        [`keywords/${m.action.includes("star") ? "$flagged" : "$seen"}`]: [
          "read",
          "star",
        ].includes(m.action)
          ? true
          : null,
      };
    else if (["move", "trash", "archive"].includes(m.action)) {
      const dest =
        m.destination ||
        (await this.folders()).find(
          (f: any) => f.role === (m.action === "trash" ? "trash" : "archive"),
        )?.id;
      if (!dest) throw new MailError("DESTINATION_REQUIRED");
      patch = { mailboxIds: { [dest]: true } };
    } else throw new MailError("UNSUPPORTED_CAPABILITY", 422);
    const r = await this.call("Email/set", { update: { [id]: patch } });
    if (r.notUpdated?.[id]) throw new MailError("JMAP_UPDATE_FAILED", 502);
    return r;
  }
  async send(d: DraftContent, a: OutgoingAttachment[], intent: string) {
    const s = await this.session(),
      accountId = s.primaryAccounts["urn:ietf:params:jmap:mail"];
    const raw = await compose(this.config.email, d, a, intent);
    // Upload RFC822 bytes through the scoped JMAP upload endpoint.
    const upload = s.uploadUrl.replace(
      "{accountId}",
      encodeURIComponent(accountId),
    );
    const r = await this.http(this.checked(upload), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "message/rfc822",
      },
      body: raw,
    });
    if (r.status < 200 || r.status >= 300) providerError(r.status);
    const blob = JSON.parse(r.body.toString()),
      drafts = (await this.folders()).find((f: any) => f.role === "drafts");
    if (!drafts) throw new MailError("DRAFTS_FOLDER_REQUIRED");
    const imported = await this.call("Email/import", {
      emails: {
        draft: {
          blobId: blob.blobId,
          mailboxIds: { [drafts.id]: true },
          keywords: { $draft: true },
        },
      },
    });
    const emailId = imported.created?.draft?.id;
    if (!emailId) throw new MailError("JMAP_IMPORT_FAILED", 502);
    const identities = await this.call("Identity/get", {}),
      identity = identities.list.find(
        (x: any) => x.email.toLowerCase() === this.config.email.toLowerCase(),
      );
    if (!identity) throw new MailError("SEND_IDENTITY_NOT_ALLOWED", 403);
    const sent = (await this.folders()).find((f: any) => f.role === "sent");
    const submitted = await this.call("EmailSubmission/set", {
      create: {
        send: {
          emailId,
          identityId: identity.id,
          envelope: {
            mailFrom: { email: this.config.email },
            rcptTo: [...d.to, ...d.cc, ...d.bcc].map((email) => ({ email })),
          },
        },
      },
      onSuccessUpdateEmail: {
        "#send": {
          [`mailboxIds/${drafts.id}`]: null,
          "keywords/$draft": null,
          ...(sent ? { [`mailboxIds/${sent.id}`]: true } : {}),
        },
      },
    });
    return {
      state: "provider_accepted" as const,
      providerId: submitted.created?.send?.id,
      sentCopy: "provider" as const,
    };
  }
  async extension(op: string, i: Record<string, unknown>) {
    if (op === "thread") {
      const r = await this.call("Thread/get", { ids: [i.id] });
      const ids: string[] = r.list?.[0]?.emailIds ?? [];
      const m = ids.length
        ? await this.call("Email/get", {
            ids: ids.slice(0, 50),
            fetchTextBodyValues: true,
            maxBodyValueBytes: 100_000,
          })
        : { list: [] };
      return {
        items: m.list.map((x: any) => this.map(x)),
        source: "provider",
        truncated: ids.length > 50,
      };
    }
    if (op === "folders.create")
      return this.call("Mailbox/set", {
        create: {
          folder: { name: i.name, ...(i.parent ? { parentId: i.parent } : {}) },
        },
      });
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
}
