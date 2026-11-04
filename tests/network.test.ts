import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { httpClient } from "../src/network.js";
import { config } from "../src/config.js";

test("HTTP proxy preserves DNS pinning, TLS identity and bounded responses", async (t) => {
  const sockets = new Set<Socket>();
  const seen: { path?: string; headers: Record<string, unknown> }[] = [];
  let tlsName: string | undefined;
  const upstream = httpsServer(
    {
      key: readFileSync(".test-certs/server.key"),
      cert: readFileSync(".test-certs/ca.crt"),
    },
    (req, res) => {
      seen.push({ path: req.url, headers: req.headers });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://127.0.0.1/denied" });
        res.end();
      } else {
        res.setHeader("x-test", "upstream");
        res.end("proxy fixture");
      }
    },
  );
  upstream.on("secureConnection", (socket) => {
    tlsName = socket.servername || undefined;
  });
  upstream.on("tlsClientError", () => {});
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as AddressInfo).port;
  const tunnels: { path?: string; headers: Record<string, unknown> }[] = [];
  const proxy = httpServer();
  proxy.on("connect", (req, client, head) => {
    tunnels.push({ path: req.url, headers: req.headers });
    const remote = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
    for (const socket of [client, remote]) {
      sockets.add(socket as Socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket as Socket));
    }
    client.on("close", () => remote.destroy());
    remote.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });
  const outboundProxy = `http://lab:secret@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const http = httpClient({
    privateEndpoints: [`localhost:${port}`],
    outboundProxy,
  });
  const r = await http(`https://localhost:${port}/fixture?x=1`, {
    headers: { authorization: "Bearer lab-mailbox", Host: "attacker.invalid" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "proxy fixture");
  assert.equal(r.headers["x-test"], "upstream");
  assert.equal(tlsName, "localhost");
  assert.equal(tunnels[0]!.path, `127.0.0.1:${port}`);
  assert.equal(tunnels[0]!.headers.authorization, undefined);
  assert.equal(
    tunnels[0]!.headers["proxy-authorization"],
    "Basic bGFiOnNlY3JldA==",
  );
  assert.equal(seen[0]!.path, "/fixture?x=1");
  assert.equal(seen[0]!.headers.host, `localhost:${port}`);
  assert.equal(seen[0]!.headers.authorization, "Bearer lab-mailbox");
  assert.equal(seen[0]!.headers["proxy-authorization"], undefined);
  const before = tunnels.length;
  await assert.rejects(
    httpClient({ privateEndpoints: [], outboundProxy })(
      `https://127.0.0.1:${port}/`,
    ),
    /NETWORK_PORT_DENIED|NETWORK_DESTINATION_DENIED/,
  );
  assert.equal(tunnels.length, before);
  assert.equal((await http(`https://localhost:${port}/redirect`)).status, 302);
  assert.equal(seen.length, 2);
  await assert.rejects(
    http(`https://localhost:${port}/large`, { maxBytes: 3 }),
    /RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    httpClient({ privateEndpoints: [`127.0.0.2:${port}`], outboundProxy })(
      `https://127.0.0.2:${port}/`,
    ),
    (error: any) =>
      /ALTNAME|IP.*cert|certificate/i.test(
        String(
          error.cause?.code ??
            error.cause?.message ??
            error.code ??
            error.message,
        ),
      ),
  );
});

test("proxy configuration accepts only HTTP(S) proxy origins", () => {
  const env = {
    DATABASE_URL: "lab",
    ENCRYPTION_KEY: "lab",
    BASE_URL: "https://anymail.invalid",
    OIDC_ISSUER: "https://issuer.invalid",
    OIDC_AUDIENCE: "https://anymail.invalid/mcp",
    OIDC_CLIENT_ID: "web",
    ALLOWED_CLIENT_IDS: "web",
  };
  for (const value of [
    "socks5://localhost:1080",
    "http://proxy/path",
    "https://proxy/?x=1",
    "http://proxy/#x",
    "invalid",
  ])
    assert.throws(() => config({ ...env, OUTBOUND_PROXY_URL: value }));
  for (const value of [
    "",
    "http://localhost:7897",
    "https://user:pass@proxy.invalid:3128",
  ])
    assert.equal(
      config({ ...env, OUTBOUND_PROXY_URL: value }).OUTBOUND_PROXY_URL,
      value,
    );
});
