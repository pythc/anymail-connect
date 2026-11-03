import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";
import { MailError } from "./domain.js";
export type NetworkPolicy = { privateEndpoints: string[] };
export async function resolveEndpoint(
  host: string,
  port: number,
  policy: NetworkPolicy,
) {
  if (!host || /[\s/@\\?#%]/.test(host)) throw new MailError("INVALID_HOST");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new MailError("DNS_FAILED", 502);
  const allowPrivate = policy.privateEndpoints.includes(
    `${host.toLowerCase()}:${port}`,
  );
  if (![443, 993, 143, 465, 587].includes(port) && !allowPrivate)
    throw new MailError("NETWORK_PORT_DENIED", 403);
  for (const a of addresses) {
    if (!allowPrivate && ipaddr.process(a.address).range() !== "unicast")
      throw new MailError("NETWORK_DESTINATION_DENIED", 403);
  }
  return addresses;
}
export type HttpRequest = (
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    maxBytes?: number;
  },
) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
export function httpClient(policy: NetworkPolicy): HttpRequest {
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password)
      throw new MailError("INSECURE_URL");
    const addresses = await resolveEndpoint(
      u.hostname,
      Number(u.port || 443),
      policy,
    );
    const first = addresses[0]!;
    const agent = new Agent({
      connect: {
        lookup: (_host, opts, cb) => {
          if (typeof opts === "object" && opts.all)
            cb(null, addresses as never);
          else cb(null, first.address, first.family);
        },
      },
    });
    try {
      const r = await fetch(u, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        dispatcher: agent,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const max = options.maxBytes ?? 10 * 1024 * 1024,
        chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of r.body ?? []) {
        size += chunk.length;
        if (size > max) {
          await r.body?.cancel().catch(() => {});
          throw new MailError("RESPONSE_TOO_LARGE", 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body: Buffer.concat(chunks),
      };
    } finally {
      await agent.close();
    }
  };
}
export function providerError(
  status: number,
  headers: Record<string, string> = {},
): never {
  if (status === 401) throw new MailError("PROVIDER_AUTH_REQUIRED", 401);
  if (status === 403) throw new MailError("PROVIDER_PERMISSION_DENIED", 403);
  if (status === 404) throw new MailError("NOT_FOUND", 404);
  if (status === 429)
    throw new MailError("RATE_LIMITED", 429, {
      retryAfter: headers["retry-after"] || null,
    });
  throw new MailError("PROVIDER_ERROR", 502, { providerStatus: status });
}
