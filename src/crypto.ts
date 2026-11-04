import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { MailError } from "./domain.js";
export class Vault {
  private key: Buffer;
  private keys: Map<string, Buffer>;
  constructor(
    encoded: string,
    private keyId = "primary",
    previous: Record<string, string> = {},
  ) {
    this.key = Buffer.from(encoded, "base64");
    if (this.key.length !== 32)
      throw new Error("ENCRYPTION_KEY must be a base64 32-byte key");
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(keyId) || Object.hasOwn(previous, keyId))
      throw Error("INVALID_KEY_RING");
    this.keys = new Map(
      Object.entries(previous).map(([id, key]) => [
        id,
        Buffer.from(key, "base64"),
      ]),
    );
    this.keys.set(keyId, this.key);
    if (
      [...this.keys.entries()].some(
        ([id, key]) => !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || key.length !== 32,
      )
    )
      throw Error("INVALID_KEY_RING");
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return (
      `v2.${this.keyId}.` +
      Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")
    );
  }
  open<T>(value: string, context: string): T {
    const parts = value.split(".");
    const keys =
      parts.length === 3 && parts[0] === "v2"
        ? [this.keys.get(parts[1]!)].filter((k): k is Buffer => !!k)
        : parts.length === 1
          ? [...this.keys.values()]
          : [];
    for (const key of keys) {
      try {
        const b = Buffer.from(parts.length === 1 ? value : parts[2]!, "base64"),
          d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
        d.setAAD(Buffer.from(context));
        d.setAuthTag(b.subarray(12, 28));
        return JSON.parse(
          Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
        ) as T;
      } catch {}
    }
    throw new MailError("CREDENTIAL_DECRYPTION_FAILED", 500);
  }
  current(value: string) {
    return value.startsWith(`v2.${this.keyId}.`);
  }
}
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const secretEqual = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export const opaque = () => randomBytes(32).toString("base64url");
