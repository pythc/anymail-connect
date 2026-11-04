import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, ProxyAgent, fetch, request } from "undici";
import { MailError } from "./domain.js";
export type NetworkPolicy = {
  privateEndpoints: string[];
  outboundProxy?: string;
};
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
    const first = addresses.find((a) => a.family === 4) ?? addresses[0]!;
    const target = new URL(u);
    // CONNECT an already-approved IP so the proxy cannot resolve a different
    // destination. Keep the original Host and certificate/SNI identity.
    if (policy.outboundProxy)
      target.hostname =
        first.family === 6 ? `[${first.address}]` : first.address;
    const agent = policy.outboundProxy
      ? new ProxyAgent({
          uri: policy.outboundProxy,
          requestTls: { servername: isIP(u.hostname) ? undefined : u.hostname },
        })
      : new Agent({
          connect: {
            lookup: (_host, opts, cb) => {
              if (typeof opts === "object" && opts.all)
                cb(null, addresses as never);
              else cb(null, first.address, first.family);
            },
          },
        });
    try {
      const common = {
        method: options.method || "GET",
        body: options.body,
        dispatcher: agent,
        signal: AbortSignal.timeout(30_000),
      };
      // fetch discards a caller-supplied Host. request preserves it for the
      // IP-addressed tunnel and never follows redirects by default.
      const headers = new Headers(options.headers);
      headers.set("host", u.host);
      const r = policy.outboundProxy
        ? await request(target, {
            ...common,
            headers: Object.fromEntries(headers.entries()),
          })
        : await fetch(u, {
            ...common,
            headers: options.headers,
            redirect: "manual",
          });
      const max = options.maxBytes ?? 10 * 1024 * 1024,
        chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of r.body ?? []) {
        size += chunk.length;
        if (size > max) {
          throw new MailError("RESPONSE_TOO_LARGE", 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      return {
        status: "statusCode" in r ? r.statusCode : r.status,
        headers:
          "statusCode" in r
            ? Object.fromEntries(
                Object.entries(r.headers)
                  .filter((entry) => entry[1] !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!]),
              )
            : Object.fromEntries(r.headers.entries()),
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
  if (status === 409 || status === 412)
    throw new MailError("REVISION_CONFLICT", 409);
  if (status === 429)
    throw new MailError("RATE_LIMITED", 429, {
      retryAfter: headers["retry-after"] || null,
    });
  throw new MailError("PROVIDER_ERROR", 502, { providerStatus: status });
}
