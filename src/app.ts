import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import * as oidc from "openid-client";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { hash, opaque, secretEqual } from "./crypto.js";
import { MailError, type Principal } from "./domain.js";
import type { Config } from "./config.js";
import type { Verify } from "./auth.js";
import type { MailService } from "./service.js";
import { tools } from "./tools.js";
import { mcp } from "./mcp.js";
import { ProviderOAuth } from "./provider-oauth.js";
import { page, style, script, escape, approvalPage } from "./ui.js";
type Session = { principal: Principal; csrf: string; expiresAt: number };
export async function app(
  service: MailService,
  config: Config,
  verify: Verify,
  settings?: oidc.Configuration,
) {
  const f = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    logger: false,
    trustProxy: false,
  });
  await f.register(cookie);
  await f.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  f.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  f.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    if (
      req.url !== "/healthz" &&
      req.headers.host !== new URL(config.BASE_URL).host
    )
      throw new MailError("INVALID_HOST", 403);
    if (
      req.headers.origin &&
      req.headers.origin !== config.BASE_URL &&
      !(req.url === "/mcp" && req.headers.origin === "https://chatgpt.com")
    )
      throw new MailError("INVALID_ORIGIN", 403);
  });
  f.setErrorHandler((e, _req, reply) => {
    const error =
      e instanceof MailError
        ? e.code
        : e instanceof z.ZodError
          ? "INVALID_INPUT"
          : "REQUEST_FAILED";
    const status =
      e instanceof MailError
        ? e.status
        : e instanceof z.ZodError
          ? 400
          : (e as any).statusCode || 500;
    if (status === 401)
      reply.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.BASE_URL}/.well-known/oauth-protected-resource", scope="mail.read"`,
      );
    reply.status(status).send({ error });
  });
  const secure = config.BASE_URL.startsWith("https:");
  async function session(req: FastifyRequest) {
    const sid = req.cookies.anymail_session;
    if (!sid) throw new MailError("AUTH_REQUIRED", 401);
    const row = await service.store.session<{ sealed: string }>(
      "web:" + hash(sid),
    );
    if (!row) throw new MailError("AUTH_REQUIRED", 401);
    const s = service.vault.open<Session>(row.sealed, "web:" + hash(sid));
    if (s.expiresAt <= Date.now()) throw new MailError("AUTH_REQUIRED", 401);
    return s;
  }
  async function principal(req: FastifyRequest, write = false) {
    if (req.headers.authorization) {
      if (!req.headers.authorization.startsWith("Bearer "))
        throw new MailError("AUTH_REQUIRED", 401);
      return (await verify(req.headers.authorization.slice(7))).principal;
    }
    const s = await session(req);
    if (
      write &&
      !secretEqual(String(req.headers["x-csrf-token"] || ""), s.csrf)
    )
      throw new MailError("CSRF_REQUIRED", 403);
    return s.principal;
  }
  f.get("/healthz", async () => ({ status: "ok", version: "0.1.0" }));
  f.get("/.well-known/oauth-protected-resource", async () => ({
    resource: config.OIDC_AUDIENCE,
    authorization_servers: [config.OIDC_ISSUER],
    scopes_supported: ["mail.read", "mail.write", "mail.send"],
    bearer_methods_supported: ["header"],
  }));
  f.get("/.well-known/oauth-protected-resource/mcp", async () => ({
    resource: config.OIDC_AUDIENCE,
    authorization_servers: [config.OIDC_ISSUER],
    scopes_supported: ["mail.read", "mail.write", "mail.send"],
  }));
  f.get("/", async (_req, reply) => reply.type("text/html").send(page));
  f.get("/style.css", async (_req, reply) =>
    reply.type("text/css").send(style),
  );
  f.get("/app.js", async (_req, reply) =>
    reply.type("text/javascript").send(script),
  );
  f.get("/auth/login", async (_req, reply) => {
    if (!settings) throw new MailError("OIDC_NOT_CONFIGURED", 503);
    const state = oidc.randomState(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce(),
      browser = opaque();
    await service.store.setSession(
      "login:" + state,
      {
        sealed: service.vault.seal(
          { verifier, nonce, browser },
          "login:" + state,
        ),
      },
      new Date(Date.now() + 600_000).toISOString(),
    );
    reply.setCookie("anymail_login", browser, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return reply.redirect(
      oidc.buildAuthorizationUrl(settings, {
        redirect_uri: `${config.BASE_URL}/auth/callback`,
        scope: "openid profile mail.read mail.write mail.send",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      }).href,
    );
  });
  f.get("/auth/callback", async (req, reply) => {
    if (!settings) throw new MailError("OIDC_NOT_CONFIGURED", 503);
    const q = z
        .object({ state: z.string(), code: z.string() })
        .parse(req.query),
      row = await service.store.consumeSession<{ sealed: string }>(
        "login:" + q.state,
      );
    if (!row) throw new MailError("LOGIN_STATE_INVALID", 403);
    const flow = service.vault.open<{
      verifier: string;
      nonce: string;
      browser: string;
    }>(row.sealed, "login:" + q.state);
    if (!secretEqual(flow.browser, req.cookies.anymail_login || ""))
      throw new MailError("LOGIN_BROWSER_MISMATCH", 403);
    const grant = await oidc.authorizationCodeGrant(
      settings,
      new URL(req.url, config.BASE_URL),
      {
        pkceCodeVerifier: flow.verifier,
        expectedState: q.state,
        expectedNonce: flow.nonce,
      },
    );
    const identity = await verify(grant.access_token),
      sid = opaque(),
      value: Session = { ...identity, csrf: opaque() };
    await service.store.setSession(
      "web:" + hash(sid),
      { sealed: service.vault.seal(value, "web:" + hash(sid)) },
      new Date(value.expiresAt).toISOString(),
    );
    reply.clearCookie("anymail_login", { path: "/" });
    reply.setCookie("anymail_session", sid, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor((value.expiresAt - Date.now()) / 1000),
    });
    return reply.redirect("/");
  });
  f.get("/api/me", async (req) => {
    const s = await session(req);
    return { principal: s.principal, csrf: s.csrf };
  });
  f.post("/api/logout", async (req, reply) => {
    await principal(req, true);
    const sid = req.cookies.anymail_session;
    if (sid) await service.store.consumeSession("web:" + hash(sid));
    reply.clearCookie("anymail_session", { path: "/" });
    return { ok: true };
  });
  const registry = new Map(tools(service).map((t) => [t.name, t]));
  f.post("/api/call/:tool", async (req) => {
    const { tool } = req.params as { tool: string };
    const t = registry.get(tool);
    if (!t) throw new MailError("NOT_FOUND", 404);
    const p = await principal(req, !t.readOnly);
    return t.run(p, t.schema.parse(req.body));
  });
  f.post("/api/accounts/connect", async (req) => {
    const p = await principal(req, true),
      i = z
        .object({
          connection: z.unknown(),
          writable: z.boolean().default(false),
          sendEnabled: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    return service.connect(p, i.connection, i.writable, i.sendEnabled);
  });
  f.post("/api/accounts/revoke", async (req) => {
    const p = await principal(req, true),
      i = z.object({ account_id: z.string().uuid() }).strict().parse(req.body);
    await service.revoke(p, i.account_id);
    return { revoked: true };
  });
  f.post("/api/upload", async (req) => {
    const p = await principal(req, true),
      i = z
        .object({
          account_id: z.string().uuid(),
          name: z.string(),
          type: z.string(),
          content: z
            .string()
            .max(7_000_000)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        })
        .strict()
        .parse(req.body);
    return service.upload(
      p,
      i.account_id,
      i.name,
      i.type,
      Buffer.from(i.content, "base64"),
    );
  });
  f.get(
    "/api/attachments/:account/:message/:attachment",
    async (req, reply) => {
      const p = await principal(req),
        i = req.params as Record<string, string>;
      const a = await service.attachment(
        p,
        i.account!,
        i.message!,
        i.attachment!,
      );
      return reply
        .type("application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        )
        .send(a.content);
    },
  );
  const oauth = new ProviderOAuth(service, config);
  f.post("/api/oauth/start", async (req) => {
    const p = (await session(req)).principal;
    await principal(req, true);
    const i = z
      .object({
        provider: z.enum(["gmail", "graph"]),
        writable: z.boolean(),
        sendEnabled: z.boolean(),
        mailbox: z.string().email().optional(),
      })
      .strict()
      .parse(req.body);
    return {
      url: await oauth.start(
        p,
        i.provider,
        i.writable,
        i.sendEnabled,
        i.mailbox,
      ),
    };
  });
  f.get("/oauth/provider/callback", async (req, reply) => {
    const p = (await session(req)).principal,
      q = z.object({ state: z.string(), code: z.string() }).parse(req.query);
    await oauth.callback(p, q.state, q.code);
    return reply.redirect("/");
  });
  f.get("/message/:account/:message", async (req, reply) => {
    if (!req.cookies.anymail_session) return reply.redirect("/auth/login");
    const p = (await session(req)).principal,
      i = req.params as Record<string, string>,
      m = await service.get(p, i.account!, i.message!);
    return reply
      .type("text/html")
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(m.subject)}</title><link rel="stylesheet" href="/style.css"><main><h1>${escape(m.subject)}</h1><p>${escape(m.from)} · ${escape(m.date)}</p><pre>${escape(m.text)}</pre><a href="/">返回</a></main></html>`,
      );
  });
  f.get("/approve/:id", async (req, reply) => {
    if (!req.cookies.anymail_session) return reply.redirect("/auth/login");
    const s = await session(req),
      operation = await service.operation(
        s.principal,
        z
          .string()
          .uuid()
          .parse((req.params as any).id),
      );
    return reply.type("text/html").send(approvalPage(operation, s.csrf));
  });
  f.post("/approve/:id", async (req, reply) => {
    if (req.headers.authorization)
      throw new MailError("BROWSER_APPROVAL_REQUIRED", 403);
    const s = await session(req),
      i = z
        .object({ csrf: z.string(), digest: z.string() })
        .strict()
        .parse(req.body);
    if (!secretEqual(i.csrf, s.csrf)) throw new MailError("CSRF_REQUIRED", 403);
    const op = await service.approve(
      s.principal,
      z
        .string()
        .uuid()
        .parse((req.params as any).id),
      i.digest,
    );
    return reply
      .type("text/html")
      .send(
        `<html lang="zh-CN"><meta charset="utf-8"><main><h1>已批准</h1><p>操作 ${escape(op.id)} 已进入持久队列，后台将按计划提交。</p><a href="/">返回</a></main></html>`,
      );
  });
  f.all("/mcp", async (req, reply) => {
    const p = await principal(req);
    if (req.method !== "POST")
      return reply.code(405).send({ error: "METHOD_NOT_ALLOWED" });
    const server = mcp(service, p),
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  return f;
}
