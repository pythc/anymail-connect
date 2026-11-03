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
  constructor(encoded: string) {
    this.key = Buffer.from(encoded, "base64");
    if (this.key.length !== 32)
      throw new Error("ENCRYPTION_KEY must be a base64 32-byte key");
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  open<T>(value: string, context: string): T {
    try {
      const b = Buffer.from(value, "base64"),
        d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
      ) as T;
    } catch {
      throw new MailError("CREDENTIAL_DECRYPTION_FAILED", 500);
    }
  }
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secretEqual = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export const opaque = () => randomBytes(32).toString("base64url");
