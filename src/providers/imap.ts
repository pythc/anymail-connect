import {
  ImapFlow,
  type ImapFlowOptions,
  type FetchMessageObject,
} from "imapflow";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
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
import { resolveEndpoint, type NetworkPolicy } from "../network.js";
import { cursorDecode, cursorEncode } from "./rest.js";
import { compose } from "./gmail.js";
type ImapConnection = Extract<Connection, { provider: "imap" }>;
type Locator = { folder: string; validity: string; uid: number };
const MAX_MESSAGE = 8 * 1024 * 1024;
export function locator(id: string): Locator {
  const l = cursorDecode<Locator>(id);
  if (
    !l ||
    typeof l.folder !== "string" ||
    l.folder.length > 500 ||
    !/^\d+$/.test(l.validity) ||
    !Number.isSafeInteger(l.uid) ||
    l.uid < 1
  )
    throw new MailError("INVALID_MESSAGE_ID");
  return l;
}
export class ImapProvider implements MailProvider {
  capabilities = { ...baseCapabilities };
  constructor(
    private config: ImapConnection,
    private policy: NetworkPolicy,
  ) {}
  private async client() {
    const c = this.config,
      address = (
        await resolveEndpoint(c.imap.host, c.imap.port, this.policy)
      )[0]!;
    const options: ImapFlowOptions = {
      host: address.address,
      port: c.imap.port,
      secure: c.imap.secure,
      ...(c.imap.secure ? {} : { doSTARTTLS: true }),
      ...(isIP(c.imap.host) ? {} : { servername: c.imap.host }),
      auth: { user: c.username, pass: c.password },
      logger: false,
      tls: {
        rejectUnauthorized: true,
        ...(isIP(c.imap.host) ? {} : { servername: c.imap.host }),
      },
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
      maxLiteralSize: MAX_MESSAGE,
    };
    const client = new ImapFlow(options);
    client.on("error", () => {});
    await client.connect();
    return client;
  }
  private async withClient<T>(fn: (c: ImapFlow) => Promise<T>) {
    const c = await this.client();
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => c.close());
    }
  }
  private async selected<T>(l: Locator, fn: (c: ImapFlow) => Promise<T>) {
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock(l.folder);
      try {
        if (!c.mailbox || String(c.mailbox.uidValidity) !== l.validity)
          throw new MailError("STALE_REFERENCE", 409);
        return await fn(c);
      } finally {
        lock.release();
      }
    });
  }
  async verify() {
    await this.withClient(async (c) => {
      await c.mailboxOpen("INBOX", { readOnly: true });
    });
    return { email: this.config.email };
  }
  private async parse(
    f: FetchMessageObject,
    folder: string,
    validity: string,
  ): Promise<Message> {
    if (f.source && (f.size ?? f.source.length) > MAX_MESSAGE)
      throw new MailError("MESSAGE_TOO_LARGE", 413);
    const p = f.source ? await simpleParser(f.source) : undefined;
    const addr = (x: any) =>
      x?.value?.map((a: any) => a.address).filter(Boolean) ?? [];
    return {
      id: cursorEncode({ folder, validity, uid: f.uid }),
      subject: p?.subject ?? f.envelope?.subject ?? "",
      from: addr(p?.from)[0] ?? f.envelope?.from?.[0]?.address ?? "",
      to: addr(p?.to),
      cc: addr(p?.cc),
      replyTo: addr(p?.replyTo),
      date: new Date(p?.date ?? f.internalDate ?? 0).toISOString(),
      text: p?.text ?? "",
      html: p?.html || undefined,
      read: f.flags?.has("\\Seen") ?? false,
      messageId: p?.messageId,
      references:
        typeof p?.references === "string" ? [p.references] : p?.references,
      folder,
      threadSource: "inferred",
      headers: p
        ? Object.fromEntries(
            [...p.headers]
              .filter(([k]) =>
                ["list-unsubscribe", "list-unsubscribe-post"].includes(k),
              )
              .map(([k, v]) => [k, String(v)]),
          )
        : {},
      attachments:
        p?.attachments.map((a, i) => ({
          id: String(i),
          name: a.filename ?? "attachment",
          type: a.contentType,
          size: a.size,
        })) ?? [],
    };
  }
  async search(s: Search) {
    const folder = s.folder || "INBOX";
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        if (!c.mailbox) throw new MailError("NOT_FOUND", 404);
        const validity = String(c.mailbox.uidValidity),
          before = s.cursor ? cursorDecode<Locator>(s.cursor) : undefined;
        if (
          before &&
          (before.folder !== folder ||
            before.validity !== validity ||
            !Number.isSafeInteger(before.uid))
        )
          throw new MailError("STALE_REFERENCE", 409);
        const found = await c.search(
          {
            ...(s.query ? { body: s.query } : {}),
            ...(s.from ? { from: s.from } : {}),
            ...(s.subject ? { subject: s.subject } : {}),
            ...(s.after ? { since: new Date(s.after) } : {}),
            ...(s.before ? { before: new Date(s.before) } : {}),
            ...(s.unread !== undefined ? { seen: !s.unread } : {}),
          },
          { uid: true },
        );
        const uids = (found || [])
            .filter((uid) => !before || uid < before.uid)
            .sort((a, b) => b - a),
          page = uids.slice(0, s.limit);
        const fetched = page.length
          ? await c.fetchAll(
              page,
              {
                uid: true,
                envelope: true,
                flags: true,
                internalDate: true,
                size: true,
              },
              { uid: true },
            )
          : [];
        const items = await Promise.all(
          fetched
            .sort((a, b) => b.uid - a.uid)
            .map((f) => this.parse(f, folder, validity)),
        );
        return {
          items,
          cursor:
            uids.length > s.limit
              ? cursorEncode({ folder, validity, uid: page.at(-1) })
              : undefined,
          coverage:
            "provider-search:specified-folder; list contains headers only",
        };
      } finally {
        lock.release();
      }
    });
  }
  async get(id: string) {
    const l = locator(id);
    return this.selected(l, async (c) => {
      const meta = await c.fetchOne(l.uid, { size: true }, { uid: true });
      if (!meta) throw new MailError("NOT_FOUND", 404);
      if ((meta.size ?? MAX_MESSAGE + 1) > MAX_MESSAGE)
        throw new MailError("MESSAGE_TOO_LARGE", 413);
      const f = await c.fetchOne(
        l.uid,
        {
          source: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        },
        { uid: true },
      );
      if (!f) throw new MailError("NOT_FOUND", 404);
      return this.parse(f, l.folder, l.validity);
    });
  }
  async attachment(messageId: string, attachmentId: string) {
    const l = locator(messageId);
    if (!/^\d+$/.test(attachmentId)) throw new MailError("NOT_FOUND", 404);
    return this.selected(l, async (c) => {
      const meta = await c.fetchOne(l.uid, { size: true }, { uid: true });
      if (!meta) throw new MailError("NOT_FOUND", 404);
      if ((meta.size ?? MAX_MESSAGE + 1) > MAX_MESSAGE)
        throw new MailError("MESSAGE_TOO_LARGE", 413);
      const f = await c.fetchOne(l.uid, { source: true }, { uid: true });
      if (!f || !f.source) throw new MailError("NOT_FOUND", 404);
      const p = await simpleParser(f.source),
        a = p.attachments[Number(attachmentId)];
      if (!a) throw new MailError("NOT_FOUND", 404);
      return {
        content: a.content,
        type: a.contentType,
        name: a.filename || "attachment",
      };
    });
  }
  async folders() {
    return this.withClient(async (c) =>
      (await c.list()).map((f) => ({
        id: f.path,
        name: f.name,
        role: f.specialUse,
      })),
    );
  }
  async mutate(id: string, m: Mutation) {
    return this.selected(locator(id), async (c) => {
      const uid = locator(id).uid;
      if (["read", "unread", "star", "unstar"].includes(m.action)) {
        const flag = m.action.includes("star") ? "\\Flagged" : "\\Seen";
        return ["read", "star"].includes(m.action)
          ? c.messageFlagsAdd(uid, [flag], { uid: true })
          : c.messageFlagsRemove(uid, [flag], { uid: true });
      }
      let destination = m.destination;
      if (m.action === "trash" || m.action === "archive") {
        const role = m.action === "trash" ? "\\Trash" : "\\Archive";
        destination = (await c.list()).find((f) => f.specialUse === role)?.path;
      }
      if (!["move", "trash", "archive"].includes(m.action) || !destination)
        throw new MailError("UNSUPPORTED_CAPABILITY", 422);
      if (!c.capabilities.has("MOVE"))
        throw new MailError("SAFE_MOVE_UNSUPPORTED", 422);
      return c.messageMove(uid, destination, { uid: true });
    });
  }
  async send(
    d: DraftContent,
    attachments: OutgoingAttachment[],
    intent: string,
  ) {
    const c = this.config,
      address = (
        await resolveEndpoint(c.smtp.host, c.smtp.port, this.policy)
      )[0]!;
    const transport = nodemailer.createTransport({
      host: address.address,
      port: c.smtp.port,
      secure: c.smtp.secure,
      requireTLS: !c.smtp.secure,
      auth: { user: c.username, pass: c.password },
      tls: {
        ...(isIP(c.smtp.host) ? {} : { servername: c.smtp.host }),
        rejectUnauthorized: true,
      },
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
    });
    const raw = await compose(c.email, d, attachments, intent, false);
    let info;
    try {
      info = await transport.sendMail({
        envelope: { from: c.email, to: [...d.to, ...d.cc, ...d.bcc] },
        raw,
      });
    } finally {
      transport.close();
    }
    let sentCopy: "saved" | "failed" | "provider" = "provider";
    if (c.saveSentCopy) {
      try {
        const sentRaw = await compose(c.email, d, attachments, intent, true);
        await this.withClient(async (imap) => {
          const folder =
            c.sentFolder ||
            (await imap.list()).find((f) => f.specialUse === "\\Sent")?.path;
          if (!folder) throw new MailError("SENT_FOLDER_NOT_FOUND");
          await imap.append(folder, sentRaw, ["\\Seen"]);
        });
        sentCopy = "saved";
      } catch {
        sentCopy = "failed";
      }
    }
    return {
      state: "provider_accepted" as const,
      providerId: info.messageId,
      accepted: info.accepted?.map(String),
      rejected: info.rejected?.map(String),
      sentCopy,
    };
  }
  async extension(op: string, i: Record<string, unknown>) {
    if (op === "thread") {
      const root = await this.get(String(i.id)),
        keys = new Set(
          [root.messageId, ...(root.references || [])].filter(Boolean),
        ),
        page = await this.search({ query: "", folder: root.folder, limit: 50 });
      const candidates: Message[] = [];
      for (const item of page.items) {
        const m = item.id === root.id ? root : await this.get(item.id);
        if (
          (m.messageId && keys.has(m.messageId)) ||
          m.references?.some((ref) => keys.has(ref))
        )
          candidates.push(m);
      }
      return {
        items: candidates,
        source: "inferred-from-message-headers",
        coverage: "up to 50 recent messages in the selected folder",
        complete: false,
      };
    }
    if (op === "folders.create")
      return this.withClient((c) => c.mailboxCreate(String(i.name)));
    throw new MailError("UNSUPPORTED_CAPABILITY", 422);
  }
}
