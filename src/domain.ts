import { z } from "zod";

export class MailError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
export type Principal = {
  tenant: string;
  subject: string;
  client: string;
  scopes: string[];
};
export type ProviderName = "gmail" | "graph" | "imap" | "jmap" | "ews";
const carddavSchema = z
  .object({
    url: z.string().url(),
    username: z
      .string()
      .min(1)
      .max(300)
      .refine((s) => !s.includes(":")),
    password: z.string().min(1),
  })
  .strict();
export const endpointSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean().default(true),
  })
  .strict();
export const oauthCredentialSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tenant: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+$/)
      .default("common"),
  })
  .strict();
export const connectionSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("imap"),
      carddav: carddavSchema.optional(),
      email: z.string().email(),
      username: z.string().min(1),
      password: z.string().min(1),
      imap: endpointSchema,
      smtp: endpointSchema,
      sentFolder: z.string().optional(),
      saveSentCopy: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gmail"),
      carddav: carddavSchema.optional(),
      email: z.string().email(),
      oauth: oauthCredentialSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("graph"),
      carddav: carddavSchema.optional(),
      cloud: z.enum(["global", "usgov", "usgovdod", "china"]).default("global"),
      email: z.string().email(),
      mailbox: z.string().email().optional(),
      oauth: oauthCredentialSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("jmap"),
      carddav: carddavSchema.optional(),
      email: z.string().email(),
      sessionUrl: z.string().url(),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      provider: z.literal("ews"),
      email: z.string().email(),
      url: z.string().url(),
      auth: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("basic"),
            username: z
              .string()
              .min(1)
              .refine((s) => !s.includes(":")),
            password: z.string().min(1),
          })
          .strict(),
        z
          .object({ type: z.literal("bearer"), token: z.string().min(1) })
          .strict(),
      ]),
      carddav: carddavSchema.optional(),
    })
    .strict(),
]);
export type Connection = z.infer<typeof connectionSchema>;
export type Account = {
  id: string;
  tenant: string;
  owner: string;
  provider: ProviderName;
  email: string;
  writable: boolean;
  sendEnabled: boolean;
  revoked: boolean;
  verified: boolean;
  secret: string;
  createdAt: string;
};
export type PublicAccount = Omit<Account, "secret" | "tenant" | "owner">;
export const publicAccount = ({
  secret: _s,
  tenant: _t,
  owner: _o,
  ...rest
}: Account): PublicAccount => rest;
const addresses = z.array(z.string().email().max(320)).max(100).default([]);
export const draftSchema = z
  .object({
    to: addresses,
    cc: addresses,
    bcc: addresses,
    subject: z
      .string()
      .max(998)
      .refine((s) => !/[\r\n]/.test(s)),
    text: z.string().max(500_000),
    html: z.string().max(500_000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
    inReplyTo: z
      .string()
      .max(998)
      .refine((s) => !/[\r\n]/.test(s))
      .optional(),
    references: z
      .array(
        z
          .string()
          .max(998)
          .refine((s) => !/[\r\n]/.test(s)),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type DraftContent = z.infer<typeof draftSchema>;
export type Draft = {
  id: string;
  accountId: string;
  revision: number;
  content: DraftContent;
  updatedAt: string;
  storage: "application";
};
export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
};
export type Message = {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  text: string;
  html?: string;
  read: boolean;
  messageId?: string;
  references?: string[];
  replyTo?: string[];
  threadId?: string;
  threadSource?: "provider" | "inferred";
  folder?: string;
  labels?: string[];
  attachments: Attachment[];
  headers?: Record<string, string>;
  warnings?: string[];
};
export const searchSchema = z
  .object({
    query: z.string().max(2000).default(""),
    from: z.string().max(320).optional(),
    subject: z.string().max(998).optional(),
    after: z.string().date().optional(),
    before: z.string().date().optional(),
    unread: z.boolean().optional(),
    folder: z.string().max(4000).optional(),
    cursor: z.string().max(10000).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type Search = z.infer<typeof searchSchema>;
export type Page<T> = { items: T[]; cursor?: string; coverage: string };
export type Folder = {
  id: string;
  name: string;
  role?: string;
  count?: number;
  unread?: number;
};
export type Mutation = {
  action:
    | "read"
    | "unread"
    | "star"
    | "unstar"
    | "move"
    | "trash"
    | "archive"
    | "labels"
    | "categories";
  destination?: string;
  add?: string[];
  remove?: string[];
};
export type Capability =
  | "read"
  | "send"
  | "folders"
  | "labels"
  | "categories"
  | "contacts"
  | "contactFolders"
  | "threads"
  | "nativeDrafts";
export type Capabilities = Record<
  Capability,
  "native" | "emulated" | "unsupported"
>;
export type OutgoingAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};
export type SendReceipt = {
  state: "provider_accepted";
  providerId?: string;
  accepted?: string[];
  rejected?: string[];
  sentCopy?: "saved" | "failed" | "provider";
};
export type SyncPage = {
  items: Message[];
  deleted: string[];
  checkpoint: unknown;
  complete: boolean;
  scope: string;
  reset?: boolean;
};
export interface MailProvider {
  nativeDraft?(
    id: string,
  ): Promise<{ version: string; content: DraftContent; message: Message }>;
  updateNativeDraft?(
    id: string,
    version: string,
    content: DraftContent,
    attachments: OutgoingAttachment[],
    replaceAttachments?: boolean,
    authorize?: () => Promise<void>,
  ): Promise<void>;
  capabilities: Capabilities;
  verify(): Promise<{ email: string }>;
  search(input: Search): Promise<Page<Message>>;
  get(id: string): Promise<Message>;
  attachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ content: Buffer; type: string; name: string }>;
  folders(): Promise<Folder[]>;
  mutate(id: string, mutation: Mutation): Promise<unknown>;
  send(
    draft: DraftContent,
    attachments: OutgoingAttachment[],
    intentId: string,
  ): Promise<SendReceipt>;
  extension?(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  sync?(checkpoint: any, folder?: string): Promise<SyncPage>;
  watch?(
    folder: string,
    onChange: () => void,
    signal: AbortSignal,
  ): Promise<void>;
  subscribe?(options: {
    callback: string;
    clientState: string;
    topic?: string;
    id?: string;
  }): Promise<{ id: string; expiresAt: string }>;
  unsubscribe?(id: string): Promise<void>;
}
export const baseCapabilities: Capabilities = {
  read: "native",
  send: "native",
  folders: "native",
  labels: "unsupported",
  categories: "unsupported",
  contacts: "unsupported",
  contactFolders: "unsupported",
  threads: "emulated",
  nativeDrafts: "unsupported",
};
export const requireScope = (p: Principal, scope: string) => {
  if (!p.scopes.includes(scope)) throw new MailError("PERMISSION_DENIED", 403);
};
