import { createHmac, timingSafeEqual } from "node:crypto";
import { simpleParser } from "mailparser";
import {
  baseCapabilities,
  MailError,
  type Connection,
  type MailProvider,
  type Search,
  type Message,
  type Mutation,
  type DraftContent,
  type OutgoingAttachment,
} from "../domain.js";
import { type HttpRequest, providerError } from "../network.js";
import { array, parseXml, value, xml } from "./xml.js";
import { cursorEncode, cursorDecode } from "./rest.js";
import { compose } from "./gmail.js";
type Config = Extract<Connection, { provider: "ews" }>;
type Handle = {
  kind: "message" | "contact" | "folder" | "attachment";
  id: string;
  change?: string;
  parent?: string;
};
const mailRoles = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "archiveinbox",
  "junkemail",
];
export class EwsProvider implements MailProvider {
  capabilities = { ...baseCapabilities, contacts: "native" as const };
  constructor(
    private c: Config,
    private http: HttpRequest,
    origins: string[],
    private handleKeys: readonly Buffer[],
  ) {
    if (!handleKeys.length || handleKeys.some((k) => k.length !== 32))
      throw new Error("EWS_HANDLE_KEYS_REQUIRED");
    const u = new URL(c.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !origins.includes(u.origin)
    )
      throw new MailError("EWS_ORIGIN_DENIED", 403);
  }
  // EWS IDs carry implicit mailbox authority. Only scoped response-derived,
  // authenticated typed handles may cross the AnyMail API boundary.
  private mac(payload: string, key = this.handleKeys[0]!) {
    return createHmac("sha256", key)
      .update(
        JSON.stringify([
          "anymail-ews-v1",
          this.c.url,
          this.c.email.toLowerCase(),
          this.c.auth.type,
          this.c.auth.type === "basic" ? this.c.auth.username : "",
        ]),
      )
      .update("\0" + payload)
      .digest();
  }
  private handle(h: Handle) {
    if (typeof h.id !== "string" || !h.id || h.id.length > 2000)
      throw new MailError("INVALID_PROVIDER_RESPONSE", 502);
    const payload = cursorEncode(h),
      result =
        "ews1." + payload + "." + this.mac(payload).toString("base64url");
    if (result.length > 4000)
      throw new MailError("INVALID_PROVIDER_RESPONSE", 502);
    return result;
  }
  private locator(token: string, kind: Handle["kind"]) {
    const [prefix, payload, signature, extra] = token.split(".");
    if (
      token.length > 4000 ||
      prefix !== "ews1" ||
      !payload ||
      !signature ||
      extra !== undefined
    )
      throw new MailError("INVALID_EWS_HANDLE");
    const supplied = Buffer.from(signature, "base64url");
    if (
      supplied.length !== 32 ||
      !this.handleKeys.some((key) =>
        timingSafeEqual(supplied, this.mac(payload, key)),
      )
    )
      throw new MailError("INVALID_EWS_HANDLE");
    const h = cursorDecode<Handle>(payload);
    if (
      h.kind !== kind ||
      typeof h.id !== "string" ||
      !h.id ||
      h.id.length > 2000 ||
      (h.change !== undefined &&
        (typeof h.change !== "string" || h.change.length > 2000))
    )
      throw new MailError("INVALID_EWS_HANDLE");
    return h;
  }
  private itemId(m: any, kind: "message" | "contact") {
    return this.handle({
      kind,
      id: m.ItemId?.["@_Id"],
      change: m.ItemId?.["@_ChangeKey"],
    });
  }
  private item(token: string, kind: "message" | "contact") {
    const h = this.locator(token, kind);
    return `<t:ItemId Id="${xml(h.id)}"${h.change ? ` ChangeKey="${xml(h.change)}"` : ""}/>`;
  }
  private mailFolder(id = "inbox") {
    return mailRoles.includes(id)
      ? this.folder(id)
      : `<t:FolderId Id="${xml(this.locator(id, "folder").id)}"/>`;
  }
  private folder(id = "inbox") {
    return [
      "inbox",
      "sentitems",
      "drafts",
      "deleteditems",
      "msgfolderroot",
      "contacts",
      "archiveinbox",
      "junkemail",
    ].includes(id)
      ? `<t:DistinguishedFolderId Id="${xml(id)}"><t:Mailbox><t:EmailAddress>${xml(this.c.email)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`
      : `<t:FolderId Id="${xml(this.locator(id, "folder").id)}"/>`;
  }
  private async call(op: string, body: string, attributes = "") {
    const r = await this.http(this.c.url, {
      method: "POST",
      maxBytes: 12 * 1024 * 1024,
      headers: {
        authorization:
          this.c.auth.type === "bearer"
            ? "Bearer " + this.c.auth.token
            : "Basic " +
              Buffer.from(
                this.c.auth.username + ":" + this.c.auth.password,
              ).toString("base64"),
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: `"http://schemas.microsoft.com/exchange/services/2006/messages/${op}"`,
      },
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></s:Header><s:Body><m:${op}${attributes}>${body}</m:${op}></s:Body></s:Envelope>`,
    });
    if (r.status < 200 || r.status >= 300) providerError(r.status, r.headers);
    const parsed = parseXml(r.body.toString(), 12 * 1024 * 1024).Envelope?.Body;
    if (parsed?.Fault) throw new MailError("EWS_FAULT", 502);
    const responses = array<any>(
      parsed?.[op + "Response"]?.ResponseMessages?.[op + "ResponseMessage"],
    );
    if (!responses.length)
      throw new MailError("INVALID_PROVIDER_RESPONSE", 502);
    for (const response of responses) {
      const code = value(response.ResponseCode);
      if (code !== "NoError")
        throw new MailError(
          code === "ErrorItemNotFound"
            ? "NOT_FOUND"
            : /ChangeKey|Conflict/.test(code)
              ? "REVISION_CONFLICT"
              : code === "ErrorServerBusy"
                ? "RATE_LIMITED"
                : "EWS_OPERATION_FAILED",
          code === "ErrorItemNotFound"
            ? 404
            : /ChangeKey|Conflict/.test(code)
              ? 409
              : code === "ErrorServerBusy"
                ? 429
                : 502,
        );
    }
    return responses[0];
  }
  async verify() {
    await this.call(
      "GetFolder",
      `<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds>${this.folder()}</m:FolderIds>`,
    );
    return { email: this.c.email };
  }
  private summary(m: any): Message {
    const addr = (v: any) =>
      array<any>(v?.Mailbox).map((x) => value(x.EmailAddress));
    return {
      id: this.itemId(m, "message"),
      subject: value(m.Subject),
      from: value(m.From?.Mailbox?.EmailAddress),
      to: addr(m.ToRecipients),
      cc: addr(m.CcRecipients),
      date: value(m.DateTimeReceived) || new Date(0).toISOString(),
      text: value(m.Body),
      html: m.Body?.["@_BodyType"] === "HTML" ? value(m.Body) : undefined,
      read: value(m.IsRead) === "true",
      messageId: value(m.InternetMessageId) || undefined,
      attachments: array<any>(m.Attachments?.FileAttachment).map((a) => ({
        id: this.handle({
          kind: "attachment",
          id: a.AttachmentId?.["@_Id"],
          parent: m.ItemId?.["@_Id"],
        }),
        name: value(a.Name),
        type: value(a.ContentType) || "application/octet-stream",
        size: Number(value(a.Size)) || 0,
      })),
      threadSource: "inferred",
    };
  }
  async search(s: Search) {
    const offset = s.cursor
      ? cursorDecode<{ offset: number }>(s.cursor).offset
      : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new MailError("INVALID_CURSOR");
    const filters: string[] = [];
    const comparison = (name: string, op: string, v: string) =>
      `<t:${op}><t:FieldURI FieldURI="${name}"/><t:FieldURIOrConstant><t:Constant Value="${xml(v)}"/></t:FieldURIOrConstant></t:${op}>`;
    if (s.after)
      filters.push(
        comparison(
          "item:DateTimeReceived",
          "IsGreaterThanOrEqualTo",
          s.after + "T00:00:00Z",
        ),
      );
    if (s.before)
      filters.push(
        comparison(
          "item:DateTimeReceived",
          "IsLessThan",
          s.before + "T00:00:00Z",
        ),
      );
    if (s.unread !== undefined)
      filters.push(
        comparison("message:IsRead", "IsEqualTo", String(!s.unread)),
      );
    for (const [field, v] of [
      ["item:Subject", s.subject],
      ["message:From", s.from],
    ] as const)
      if (v)
        filters.push(
          `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="${field}"/><t:Constant Value="${xml(v)}"/></t:Contains>`,
        );
    if (s.query && filters.length)
      throw new MailError("EWS_QUERY_FILTER_COMBINATION_UNSUPPORTED", 422);
    const r = await this.call(
      "FindItem",
      `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="${s.limit}" Offset="${offset}" BasePoint="Beginning"/>${filters.length ? `<m:Restriction>${filters.length > 1 ? "<t:And>" : ""}${filters.join("")}${filters.length > 1 ? "</t:And>" : ""}</m:Restriction>` : ""}<m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder><m:ParentFolderIds>${this.mailFolder(s.folder)}</m:ParentFolderIds>${s.query ? `<m:QueryString>${xml(s.query)}</m:QueryString>` : ""}`,
      ' Traversal="Shallow"',
    );
    const root = r.RootFolder,
      items = array<any>(root?.Items?.Message).map((m) => this.summary(m));
    return {
      items,
      cursor:
        root?.["@_IncludesLastItemInRange"] === "true"
          ? undefined
          : cursorEncode({ offset: offset + items.length }),
      coverage: "ews-folder-headers; query=AQS",
    };
  }
  async get(id: string) {
    const r = await this.call(
        "GetItem",
        `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent><t:BodyType>Text</t:BodyType></m:ItemShape><m:ItemIds>${this.item(id, "message")}</m:ItemIds>`,
      ),
      m = array<any>(r.Items?.Message)[0];
    if (!m) throw new MailError("NOT_FOUND", 404);
    const result = this.summary(m);
    if (m.MimeContent) {
      const p = await simpleParser(Buffer.from(value(m.MimeContent), "base64"));
      result.text = p.text ?? result.text;
      result.html = p.html || undefined;
      result.replyTo = p.replyTo?.value.map((x) => x.address!).filter(Boolean);
      result.references =
        typeof p.references === "string" ? [p.references] : p.references;
    }
    return result;
  }
  async attachment(messageId: string, attachmentId: string) {
    const rawAttachment = this.locator(attachmentId, "attachment"),
      parent = this.locator(messageId, "message").id;
    if (
      rawAttachment.parent !== parent ||
      !(await this.get(messageId)).attachments.some(
        (a) => this.locator(a.id, "attachment").id === rawAttachment.id,
      )
    )
      throw new MailError("NOT_FOUND", 404);
    const r = await this.call(
        "GetAttachment",
        `<m:AttachmentShape/><m:AttachmentIds><t:AttachmentId Id="${xml(rawAttachment.id)}"/></m:AttachmentIds>`,
      ),
      a = array<any>(r.Attachments?.FileAttachment)[0];
    if (!a) throw new MailError("NOT_FOUND", 404);
    return {
      content: Buffer.from(value(a.Content), "base64"),
      type: value(a.ContentType) || "application/octet-stream",
      name: value(a.Name),
    };
  }
  async folders() {
    const r = await this.call(
      "FindFolder",
      `<m:FolderShape><t:BaseShape>Default</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="folder:FolderClass"/></t:AdditionalProperties></m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="100" Offset="0" BasePoint="Beginning"/><m:ParentFolderIds>${this.folder("msgfolderroot")}</m:ParentFolderIds>`,
      ' Traversal="Shallow"',
    );
    return array<any>(r.RootFolder?.Folders?.Folder)
      .filter((f) => /^IPF\.Note(?:\.|$)/.test(value(f.FolderClass)))
      .map((f) => ({
        id: this.handle({ kind: "folder", id: f.FolderId?.["@_Id"] }),
        name: value(f.DisplayName),
        count: Number(value(f.TotalCount)) || 0,
      }));
  }
  async mutate(id: string, m: Mutation) {
    if (
      ["read", "unread"].includes(m.action) &&
      !this.locator(id, "message").change
    )
      throw new MailError("CHANGE_KEY_REQUIRED");
    if (m.action === "trash") {
      await this.call(
        "DeleteItem",
        `<m:ItemIds>${this.item(id, "message")}</m:ItemIds>`,
        ' DeleteType="MoveToDeletedItems"',
      );
      return { trashed: true };
    }
    if (m.action === "move" && m.destination)
      return this.call(
        "MoveItem",
        `<m:ToFolderId>${this.mailFolder(m.destination)}</m:ToFolderId><m:ItemIds>${this.item(id, "message")}</m:ItemIds>`,
      );
    if (m.action === "read" || m.action === "unread")
      return this.call(
        "UpdateItem",
        `<m:ItemChanges><t:ItemChange>${this.item(id, "message")}<t:Updates><t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>${m.action === "read"}</t:IsRead></t:Message></t:SetItemField></t:Updates></t:ItemChange></m:ItemChanges>`,
        ' ConflictResolution="NeverOverwrite" MessageDisposition="SaveOnly"',
      );
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
  async send(d: DraftContent, a: OutgoingAttachment[], intent: string) {
    const raw = await compose(this.c.email, d, a, intent);
    await this.call(
      "CreateItem",
      `<m:SavedItemFolderId>${this.folder("sentitems")}</m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">${raw.toString("base64")}</t:MimeContent></t:Message></m:Items>`,
      ' MessageDisposition="SendAndSaveCopy"',
    );
    return {
      state: "provider_accepted" as const,
      sentCopy: "provider" as const,
    };
  }
  async extension(op: string, i: any) {
    const contact = (c: any) => ({
      id: this.itemId(c, "contact"),
      displayName: value(c.DisplayName),
      givenName: value(c.GivenName),
      surname: value(c.Surname),
      emailAddresses: array<any>(c.EmailAddresses?.Entry).map((e) => ({
        address: value(e),
      })),
      businessPhones: array<any>(c.PhoneNumbers?.Entry).map(value),
    });
    if (op === "contacts.list") {
      const offset = Number(i.cursor ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
        throw new MailError("INVALID_CURSOR");
      const r = await this.call(
        "FindItem",
        `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="50" Offset="${offset}" BasePoint="Beginning"/><m:ParentFolderIds>${this.folder("contacts")}</m:ParentFolderIds>`,
        ' Traversal="Shallow"',
      );
      return {
        items: array<any>(r.RootFolder?.Items?.Contact).map(contact),
        cursor:
          r.RootFolder?.["@_IncludesLastItemInRange"] === "true"
            ? undefined
            : String(offset + 50),
        coverage: "ews-contacts",
      };
    }
    if (op === "contacts.get") {
      const r = await this.call(
          "GetItem",
          `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape><m:ItemIds>${this.item(String(i.id), "contact")}</m:ItemIds>`,
        ),
        c = array<any>(r.Items?.Contact)[0];
      if (!c) throw new MailError("NOT_FOUND", 404);
      return contact(c);
    }
    if (op === "contacts.delete") {
      await this.call(
        "DeleteItem",
        `<m:ItemIds>${this.item(String(i.id), "contact")}</m:ItemIds>`,
        ' DeleteType="MoveToDeletedItems"',
      );
      return { deleted: true };
    }
    if (op === "contacts.create" || op === "contacts.update") {
      const c = i.contact ?? {},
        props: Record<string, string> = {};
      if (
        (c.emailAddresses?.length ?? 0) > 3 ||
        (c.businessPhones?.length ?? 0) > 2
      )
        throw new MailError("EWS_CONTACT_FIELD_LIMIT");
      for (const [key, tag] of [
        ["displayName", "DisplayName"],
        ["givenName", "GivenName"],
        ["surname", "Surname"],
      ] as const)
        if (c[key] !== undefined)
          props[tag] = `<t:${tag}>${xml(c[key])}</t:${tag}>`;
      if (c.emailAddresses)
        props.EmailAddresses = `<t:EmailAddresses>${c.emailAddresses.map((e: any, n: number) => `<t:Entry Key="EmailAddress${n + 1}">${xml(e.address)}</t:Entry>`).join("")}</t:EmailAddresses>`;
      if (c.businessPhones)
        props.PhoneNumbers = `<t:PhoneNumbers>${c.businessPhones.map((p: string, n: number) => `<t:Entry Key="BusinessPhone${n ? "2" : ""}">${xml(p)}</t:Entry>`).join("")}</t:PhoneNumbers>`;
      if (op === "contacts.create") {
        const r = await this.call(
            "CreateItem",
            `<m:SavedItemFolderId>${this.folder("contacts")}</m:SavedItemFolderId><m:Items><t:Contact>${["DisplayName", "GivenName", "EmailAddresses", "PhoneNumbers", "Surname"].map((k) => props[k] ?? "").join("")}</t:Contact></m:Items>`,
          ),
          result = array<any>(r.Items?.Contact)[0];
        return result ? contact(result) : { created: true };
      }
      if (!this.locator(String(i.id), "contact").change)
        throw new MailError("CHANGE_KEY_REQUIRED");
      const updates = Object.entries(props)
        .filter(([key]) => !["EmailAddresses", "PhoneNumbers"].includes(key))
        .map(
          ([key, body]) =>
            `<t:SetItemField><t:FieldURI FieldURI="contacts:${key}"/><t:Contact>${body}</t:Contact></t:SetItemField>`,
        );
      if (c.emailAddresses || c.businessPhones) {
        const previous = await this.call(
            "GetItem",
            `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape><m:ItemIds>${this.item(String(i.id), "contact")}</m:ItemIds>`,
          ),
          old = array<any>(previous.Items?.Contact)[0];
        if (
          !old ||
          old.ItemId?.["@_ChangeKey"] !==
            this.locator(String(i.id), "contact").change
        )
          throw new MailError("REVISION_CONFLICT", 409);
        for (const [prop, field, entries] of [
          [
            "EmailAddresses",
            "EmailAddress",
            c.emailAddresses?.map((e: any) => e.address),
          ],
          ["PhoneNumbers", "PhoneNumber", c.businessPhones],
        ] as const) {
          if (!entries) continue;
          const indices =
            prop === "EmailAddresses"
              ? ["EmailAddress1", "EmailAddress2", "EmailAddress3"]
              : ["BusinessPhone", "BusinessPhone2"];
          for (const [n, index] of indices.entries()) {
            const uri = `<t:IndexedFieldURI FieldURI="contacts:${field}" FieldIndex="${index}"/>`;
            if (entries[n] !== undefined)
              updates.push(
                `<t:SetItemField>${uri}<t:Contact><t:${prop}><t:Entry Key="${index}">${xml(entries[n])}</t:Entry></t:${prop}></t:Contact></t:SetItemField>`,
              );
            else if (
              array<any>(old[prop]?.Entry).some((e) => e["@_Key"] === index)
            )
              updates.push(`<t:DeleteItemField>${uri}</t:DeleteItemField>`);
          }
        }
      }
      if (!updates.length) throw new MailError("EMPTY_CONTACT_UPDATE");
      return this.call(
        "UpdateItem",
        `<m:ItemChanges><t:ItemChange>${this.item(String(i.id), "contact")}<t:Updates>${updates.join("")}</t:Updates></t:ItemChange></m:ItemChanges>`,
        ' ConflictResolution="NeverOverwrite"',
      );
    }
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
}
