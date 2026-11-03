import { z } from "zod";
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  BASE_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().optional(),
  ALLOWED_CLIENT_IDS: z.string().min(1),
  PRIVATE_ENDPOINTS: z.string().default(""),
  PORT: z.coerce.number().default(3000),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .default("common"),
});
export type Config = z.infer<typeof envSchema>;
export function config(env = process.env): Config {
  const c = envSchema.parse(env);
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
