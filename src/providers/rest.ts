import { type HttpRequest, providerError } from "../network.js";
import { MailError } from "../domain.js";
export type TokenSource = () => Promise<string>;
export class Rest {
  constructor(
    public base: string,
    private token: TokenSource,
    private http: HttpRequest,
  ) {}
  async call<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new MailError("INVALID_PROVIDER_PATH");
    const r = await this.http(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status < 200 || r.status >= 300) providerError(r.status, r.headers);
    if (!r.body.length) return {} as T;
    try {
      return JSON.parse(r.body.toString()) as T;
    } catch {
      throw new MailError("INVALID_PROVIDER_RESPONSE", 502);
    }
  }
  async mime<T = any>(path: string, raw: Buffer): Promise<T> {
    const r = await this.http(this.base + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "text/plain",
      },
      body: raw.toString("base64"),
    });
    if (r.status < 200 || r.status >= 300) providerError(r.status, r.headers);
    return r.body.length ? (JSON.parse(r.body.toString()) as T) : ({} as T);
  }
}
export const enc = encodeURIComponent;
export const cursorEncode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export function cursorDecode<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString()) as T;
  } catch {
    throw new MailError("INVALID_CURSOR");
  }
}
export const odata = (s: string) => s.replaceAll("'", "''");
