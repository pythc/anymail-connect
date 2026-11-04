import { z } from "zod";
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/)
    .default("primary"),
  ENCRYPTION_PREVIOUS_KEYS: z.string().default("{}"),
  OIDC_INTROSPECTION: z.enum(["true", "false"]).default("false"),
  RETENTION_CACHE_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  RETENTION_DRAFT_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  OCR_ENABLED: z.enum(["true", "false"]).default("false"),
  OCR_BINARY: z.string().default("/usr/bin/tesseract"),
  OCR_LANGUAGES: z
    .string()
    .regex(/^[a-z_]+(?:\+[a-z_]+)*$/)
    .default("eng"),
  HOST_FILE_ORIGINS: z.string().default(""),
  BASE_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().optional(),
  ALLOWED_CLIENT_IDS: z.string().min(1),
  PRIVATE_ENDPOINTS: z.string().default(""),
  OUTBOUND_PROXY_URL: z.string().default(""),
  JMAP_ALLOWED_ORIGINS: z.string().default(""),
  EWS_ALLOWED_ORIGINS: z.string().default(""),
  IMAP_IDLE_CONNECTIONS: z.coerce.number().int().min(0).max(100).default(8),
  GMAIL_PUSH_TOPIC: z
    .string()
    .regex(/^projects\/[a-zA-Z0-9._:-]+\/topics\/[a-zA-Z0-9._~-]+$/)
    .optional(),
  GMAIL_PUSH_IDENTITY: z.string().email().optional(),
  PORT: z.coerce.number().default(3000),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLOUD: z
    .enum(["global", "usgov", "usgovdod", "china"])
    .default("global"),
  MICROSOFT_TENANT: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .default("common"),
});
export type Config = z.infer<typeof envSchema>;
export function config(env = process.env): Config {
  const c = envSchema.parse(env);
  if (c.OUTBOUND_PROXY_URL) {
    const proxy = new URL(c.OUTBOUND_PROXY_URL);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    )
      throw new Error("OUTBOUND_PROXY_URL requires an HTTP(S) proxy origin");
  }
  for (const raw of [c.BASE_URL, c.OIDC_ISSUER]) {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" &&
      !(
        env.NODE_ENV !== "production" &&
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )
    )
      throw new Error("HTTPS required outside loopback development");
  }
  c.BASE_URL = c.BASE_URL.replace(/\/$/, "");
  for (const origin of (
    c.JMAP_ALLOWED_ORIGINS +
    "," +
    c.HOST_FILE_ORIGINS +
    "," +
    c.EWS_ALLOWED_ORIGINS
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== origin ||
      u.username ||
      u.password
    )
      throw new Error("Origin allowlists require exact HTTPS origins");
  }
  if (
    new URL(c.BASE_URL).pathname !== "/" ||
    new URL(c.BASE_URL).search ||
    new URL(c.BASE_URL).hash ||
    c.OIDC_AUDIENCE !== c.BASE_URL + "/mcp"
  )
    throw new Error(
      "BASE_URL must be an origin and OIDC_AUDIENCE must equal BASE_URL/mcp",
    );
  return c;
}
