import {
  baseCapabilities,
  MailError,
  type MailProvider,
  type Message,
  type Search,
  type Page,
  type DraftContent,
  type OutgoingAttachment,
  type Mutation,
  draftSchema,
} from "../domain.js";
import { convert } from "html-to-text";
import { Rest, enc, cursorEncode, cursorDecode, odata } from "./rest.js";
export function graphMessage(m: any): Message {
  const headers = Object.fromEntries(
    (m.internetMessageHeaders ?? []).map((h: any) => [
      h.name.toLowerCase(),
      h.value,
    ]),
  ) as Record<string, string>;
  return {
    id: m.id,
    subject: m.subject ?? "",
    from: m.from?.emailAddress?.address ?? "",
    to: (m.toRecipients ?? []).map((x: any) => x.emailAddress.address),
    cc: (m.ccRecipients ?? []).map((x: any) => x.emailAddress.address),
    replyTo: (m.replyTo ?? []).map((x: any) => x.emailAddress.address),
    date: m.receivedDateTime ?? m.createdDateTime ?? new Date(0).toISOString(),
    text:
      m.body?.contentType?.toLowerCase() === "text"
        ? m.body.content
        : m.body?.content
          ? convert(m.body.content, { wordwrap: false })
          : (m.bodyPreview ?? ""),
    html: m.body?.contentType === "html" ? m.body.content : undefined,
    read: Boolean(m.isRead),
    messageId: m.internetMessageId,
    references: headers.references?.match(/<[^>]+>/g) ?? [],
    threadId: m.conversationId,
    threadSource: "provider",
    folder: m.parentFolderId,
    labels: m.categories ?? [],
    headers,
    attachments: (m.attachments ?? []).map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.contentType,
      size: a.size,
    })),
  };
}
export class GraphProvider implements MailProvider {
  capabilities = {
    ...baseCapabilities,
    categories: "native" as const,
    contacts: "native" as const,
    contactFolders: "native" as const,
    threads: "native" as const,
    nativeDrafts: "native" as const,
  };
  private root: string;
  constructor(
    public api: Rest,
    private mailbox?: string,
    private email = mailbox || "",
  ) {
    this.root = mailbox ? `/users/${enc(mailbox)}` : "/me";
  }
  async verify() {
    if (this.mailbox) {
      await this.api.call(this.root + "/mailFolders/inbox?$select=id");
      return { email: this.mailbox };
    }
    const r = await this.api.call(
      this.root + "?$select=mail,userPrincipalName",
    );
    return { email: r.mail || r.userPrincipalName };
  }
  async subscribe(o: { callback: string; clientState: string; id?: string }) {
    if (this.mailbox)
      throw new MailError("SHARED_MAILBOX_PUSH_UNSUPPORTED", 422);
    const resource = "/me/mailFolders('inbox')/messages";
    let id = o.id;
    if (!id) {
      const current = await this.api.call("/subscriptions");
      id = current.value?.find(
        (s: any) =>
          s.clientState === o.clientState &&
          s.notificationUrl === o.callback &&
          s.resource === resource,
      )?.id;
    }
    const expirationDateTime = new Date(
      Date.now() + 2 * 86400_000,
    ).toISOString();
    let r;
    try {
      r = id
        ? await this.api.call("/subscriptions/" + enc(id), "PATCH", {
            expirationDateTime,
          })
        : undefined;
    } catch (e) {
      if (!(e instanceof MailError && e.code === "NOT_FOUND")) throw e;
    }
    if (!r)
      r = await this.api.call("/subscriptions", "POST", {
        changeType: "created,updated,deleted",
        notificationUrl: o.callback,
        lifecycleNotificationUrl: o.callback,
        resource,
        expirationDateTime,
        clientState: o.clientState,
      });
    if (
      typeof r.id !== "string" ||
      r.id.length > 500 ||
      !Number.isFinite(Date.parse(r.expirationDateTime)) ||
      Date.parse(r.expirationDateTime) <= Date.now()
    )
      throw new MailError("INVALID_SUBSCRIPTION_RESPONSE", 502);
    return {
      id: r.id,
      expiresAt: new Date(r.expirationDateTime).toISOString(),
    };
  }
  async unsubscribe(id: string) {
    try {
      await this.api.call("/subscriptions/" + enc(id), "DELETE");
    } catch (e) {
      if (!(e instanceof MailError && e.code === "NOT_FOUND")) throw e;
    }
  }
  async search(s: Search): Promise<Page<Message>> {
    const path =
      this.root +
      (s.folder ? `/mailFolders/${enc(s.folder)}` : "") +
      "/messages";
    const filters: string[] = [];
    if (s.from) filters.push(`from/emailAddress/address eq '${odata(s.from)}'`);
    if (s.subject) filters.push(`contains(subject,'${odata(s.subject)}')`);
    if (s.after) filters.push(`receivedDateTime ge ${s.after}T00:00:00Z`);
    if (s.before) filters.push(`receivedDateTime lt ${s.before}T00:00:00Z`);
    if (s.unread !== undefined) filters.push(`isRead eq ${!s.unread}`);
    if (s.query && filters.length)
      throw new MailError("COMBINED_GRAPH_SEARCH_UNSUPPORTED", 422);
    if (!s.query && filters.length) {
      const sortedProperty = filters.findIndex((x) =>
        x.startsWith("receivedDateTime ge "),
      );
      if (sortedProperty >= 0)
        filters.unshift(filters.splice(sortedProperty, 1)[0]!);
      else filters.unshift("receivedDateTime ge 1900-01-01T00:00:00Z");
    }
    const params = new URLSearchParams({
      $top: String(s.limit),
      $expand: "attachments($select=id,name,contentType,size)",
      ...(s.query
        ? { $search: JSON.stringify(s.query) }
        : { $orderby: "receivedDateTime desc" }),
      ...(filters.length ? { $filter: filters.join(" and ") } : {}),
    });
    let next = path + "?" + params;
    if (s.cursor) {
      const c = cursorDecode<{ path: string }>(s.cursor);
      const u = new URL(c.path, this.api.base);
      if (
        u.origin !== new URL(this.api.base).origin ||
        u.pathname !== new URL(this.api.base + path).pathname
      )
        throw new MailError("INVALID_CURSOR");
      next =
        u.pathname.slice(new URL(this.api.base).pathname.length) + u.search;
    }
    const r = await this.api.call(next, "GET", undefined, {
      Prefer: 'IdType="ImmutableId"',
    });
    return {
      items: (r.value ?? []).map(graphMessage),
      cursor: r["@odata.nextLink"]
        ? cursorEncode({ path: r["@odata.nextLink"] })
        : undefined,
      coverage: "provider-search",
    };
  }
  async get(id: string) {
    return graphMessage(
      await this.api.call(
        `${this.root}/messages/${enc(id)}?$select=id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,createdDateTime,body,bodyPreview,isRead,internetMessageId,internetMessageHeaders,conversationId,parentFolderId,categories&$expand=attachments($select=id,name,contentType,size)`,
        "GET",
        undefined,
        { Prefer: 'IdType="ImmutableId"' },
      ),
    );
  }
  async attachment(messageId: string, attachmentId: string) {
    const a = await this.api.call(
      `${this.root}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
    );
    if (
      !a.contentBytes ||
      a["@odata.type"] !== "#microsoft.graph.fileAttachment"
    )
      throw new MailError("UNSUPPORTED_ATTACHMENT", 422);
    return {
      content: Buffer.from(a.contentBytes, "base64"),
      type: a.contentType,
      name: a.name,
    };
  }
  private next(url: string, expected: string) {
    const u = new URL(url, this.api.base);
    if (
      u.origin !== new URL(this.api.base).origin ||
      u.pathname !== new URL(this.api.base + expected).pathname
    )
      throw new MailError("INVALID_CURSOR");
    return u.pathname.slice(new URL(this.api.base).pathname.length) + u.search;
  }
  async folders() {
    const queue = [{ path: `${this.root}/mailFolders`, prefix: "" }],
      folders: import("../domain.js").Folder[] = [];
    for (const parent of queue) {
      let next: string | undefined =
        parent.path + "?includeHiddenFolders=false&$top=100";
      while (next) {
        const r: { value: any[]; "@odata.nextLink"?: string } =
          await this.api.call(next);
        for (const f of r.value) {
          const name = parent.prefix + f.displayName;
          folders.push({
            id: f.id,
            name,
            count: f.totalItemCount,
            unread: f.unreadItemCount,
          });
          if (folders.length > 2000)
            throw new MailError("FOLDER_TREE_TOO_LARGE", 413);
          if (f.childFolderCount)
            queue.push({
              path: `${this.root}/mailFolders/${enc(f.id)}/childFolders`,
              prefix: name + "/",
            });
        }
        next = r["@odata.nextLink"]
          ? this.next(r["@odata.nextLink"], parent.path)
          : undefined;
      }
    }
    return folders;
  }
  async mutate(id: string, m: Mutation) {
    const path = `${this.root}/messages/${enc(id)}`;
    if (["move", "trash", "archive"].includes(m.action)) {
      const destinationId =
        m.action === "trash"
          ? "deleteditems"
          : m.action === "archive"
            ? "archive"
            : m.destination;
      if (!destinationId) throw new MailError("DESTINATION_REQUIRED");
      return this.api.call(
        path + "/move",
        "POST",
        { destinationId },
        { Prefer: 'IdType="ImmutableId"' },
      );
    }
    if (m.action === "read" || m.action === "unread")
      return this.api.call(path, "PATCH", { isRead: m.action === "read" });
    if (m.action === "star" || m.action === "unstar")
      return this.api.call(path, "PATCH", {
        flag: { flagStatus: m.action === "star" ? "flagged" : "notFlagged" },
      });
    if (m.action === "categories")
      return this.api.call(path, "PATCH", { categories: m.add ?? [] });
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
  async send(d: DraftContent, a: OutgoingAttachment[], intent: string) {
    const { compose } = await import("./gmail.js");
    const raw = await compose(this.email, d, a, intent);
    await this.api.mime(`${this.root}/sendMail`, raw);
    return {
      state: "provider_accepted" as const,
      sentCopy: "provider" as const,
    };
  }
  async extension(op: string, i: Record<string, unknown>) {
    const bounded = "?$top=50",
      id = enc(String(i.id ?? ""));
    const contactsRoot =
      this.root +
      (i.folder ? `/contactFolders/${enc(String(i.folder))}` : "") +
      "/contacts";
    if (op === "categories.list")
      return this.api.call(this.root + "/outlook/masterCategories");
    if (op === "categories.create")
      return this.api.call(this.root + "/outlook/masterCategories", "POST", {
        displayName: i.name,
        color: "preset0",
      });
    if (
      op === "contacts.list" ||
      op === "contactFolders.list" ||
      op === "drafts.list"
    ) {
      const path =
        this.root +
        (op === "contacts.list"
          ? (i.folder ? `/contactFolders/${enc(String(i.folder))}` : "") +
            "/contacts"
          : op === "contactFolders.list"
            ? "/contactFolders"
            : "/mailFolders/drafts/messages");
      const r = await this.api.call(
        i.cursor ? this.next(String(i.cursor), path) : path + bounded,
      );
      return { items: r.value, cursor: r["@odata.nextLink"] ?? null };
    }
    if (op === "contacts.get") return this.api.call(`${contactsRoot}/${id}`);
    if (op === "contacts.create")
      return this.api.call(
        this.root +
          (i.folder ? `/contactFolders/${enc(String(i.folder))}` : "") +
          "/contacts",
        "POST",
        i.contact,
      );
    if (op === "contacts.update")
      return this.api.call(`${contactsRoot}/${id}`, "PATCH", i.contact);
    if (op === "contacts.delete")
      return this.api.call(`${contactsRoot}/${id}`, "DELETE");
    if (op === "contactFolders.get")
      return this.api.call(`${this.root}/contactFolders/${id}`);
    if (op === "contactFolders.create")
      return this.api.call(this.root + "/contactFolders", "POST", {
        displayName: i.name,
      });
    if (op === "contactFolders.update")
      return this.api.call(`${this.root}/contactFolders/${id}`, "PATCH", {
        displayName: i.name,
      });
    if (op === "contactFolders.delete")
      return this.api.call(`${this.root}/contactFolders/${id}`, "DELETE");
    if (op === "folders.create")
      return this.api.call(
        this.root +
          (i.parent
            ? `/mailFolders/${enc(String(i.parent))}/childFolders`
            : "/mailFolders"),
        "POST",
        { displayName: i.name },
      );
    if (op === "thread") {
      const r = await this.api.call(
        this.root +
          "/messages?" +
          new URLSearchParams({
            $filter: `conversationId eq '${odata(String(i.id))}'`,
            $top: "50",
          }),
      );
      return {
        items: r.value.map(graphMessage),
        cursor: r["@odata.nextLink"],
        source: "provider",
      };
    }
    if (op === "drafts.get")
      return this.api.call(this.root + `/messages/${id}`);
    if (op === "drafts.create") {
      const { compose } = await import("./gmail.js");
      return this.api.mime(
        this.root + "/messages",
        await compose(
          this.email,
          i.content as DraftContent,
          i.attachments as OutgoingAttachment[],
          String(i.intent),
        ),
      );
    }
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
  async sync(
    checkpoint: any,
    folder = "inbox",
  ): Promise<import("../domain.js").SyncPage> {
    const path = `${this.root}/mailFolders/${enc(folder)}/messages/delta`;
    let next = path + "?$top=50";
    if (checkpoint?.url) {
      const u = new URL(checkpoint.url);
      if (
        u.origin !== new URL(this.api.base).origin ||
        u.pathname !== new URL(this.api.base + path).pathname
      )
        throw new MailError("INVALID_CURSOR");
      next =
        u.pathname.slice(new URL(this.api.base).pathname.length) + u.search;
    }
    let r;
    try {
      r = await this.api.call(next, "GET", undefined, {
        Prefer: 'IdType="ImmutableId"',
      });
    } catch (e) {
      if (
        checkpoint &&
        e instanceof MailError &&
        (e.status === 404 || e.details?.providerStatus === 410)
      )
        return this.sync(undefined, folder);
      throw e;
    }
    return {
      items: r.value.filter((m: any) => !m["@removed"]).map(graphMessage),
      deleted: r.value.filter((m: any) => m["@removed"]).map((m: any) => m.id),
      checkpoint: { url: r["@odata.nextLink"] || r["@odata.deltaLink"] },
      complete: !r["@odata.nextLink"],
      scope: `graph:folder:${folder}`,
      reset: !checkpoint,
    };
  }
  async nativeDraft(id: string) {
    const r = await this.api.call(
      this.root +
        `/messages/${enc(id)}?$select=id,isDraft,subject,body,toRecipients,ccRecipients,bccRecipients,changeKey,internetMessageHeaders&$expand=attachments($select=id,name,contentType,size)`,
    );
    if (r.isDraft !== true) throw new MailError("NOT_A_DRAFT", 409);
    const message = graphMessage(r);
    return {
      version: String(r["@odata.etag"] ?? r.changeKey ?? ""),
      message,
      content: draftSchema.parse({
        to: message.to,
        cc: message.cc ?? [],
        bcc: (r.bccRecipients ?? []).map((x: any) => x.emailAddress.address),
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        references: message.references ?? [],
        inReplyTo: message.headers?.["in-reply-to"],
      }),
    };
  }
  async updateNativeDraft(
    id: string,
    version: string,
    content: DraftContent,
    attachments: OutgoingAttachment[],
    replaceAttachments = false,
    authorize?: () => Promise<void>,
  ) {
    await authorize?.();
    if (
      replaceAttachments &&
      attachments.some((a) => a.content.length >= 3_000_000)
    )
      throw new MailError("NATIVE_ATTACHMENT_REQUIRES_UPLOAD_SESSION", 422);
    const current = await this.nativeDraft(id);
    if (!version || current.version !== version)
      throw new MailError("REVISION_CONFLICT", 409);
    if (
      content.inReplyTo !== current.content.inReplyTo ||
      JSON.stringify(content.references) !==
        JSON.stringify(current.content.references)
    )
      throw new MailError("NATIVE_HEADER_CHANGE_UNSUPPORTED", 422);
    const recipients = (a: string[]) =>
      a.map((address) => ({ emailAddress: { address } }));
    await authorize?.();
    await this.api.call(
      this.root + `/messages/${enc(id)}`,
      "PATCH",
      {
        subject: content.subject,
        body: {
          contentType: content.html ? "HTML" : "Text",
          content: content.html ?? content.text,
        },
        toRecipients: recipients(content.to),
        ccRecipients: recipients(content.cc),
        bccRecipients: recipients(content.bcc),
      },
      { "If-Match": version },
    );
    if (replaceAttachments) {
      const path = this.root + `/messages/${enc(id)}/attachments`;
      for (const a of current.message.attachments) {
        await authorize?.();
        await this.api.call(path + "/" + enc(a.id), "DELETE");
      }
      for (const a of attachments) {
        await authorize?.();
        await this.api.call(path, "POST", {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.filename,
          contentType: a.contentType,
          contentBytes: a.content.toString("base64"),
        });
      }
    }
  }
}
