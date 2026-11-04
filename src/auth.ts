import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as oidc from "openid-client";
import { MailError, type Principal } from "./domain.js";
import type { Config } from "./config.js";
export type Verified = { principal: Principal; expiresAt: number };
export type Verify = (token: string) => Promise<Verified>;
export type InspectToken = (
  token: string,
) => Promise<{ active: boolean; sub?: string; scope?: string; exp?: number }>;
export function verifier(
  issuer: string,
  audience: string,
  clientIds: string[],
  key: JWTVerifyGetKey,
  inspect?: InspectToken,
): Verify {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer,
        audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      const tenant = payload.tenant_id,
        client = payload.azp ?? payload.client_id;
      if (
        typeof tenant !== "string" ||
        !tenant ||
        typeof client !== "string" ||
        !clientIds.includes(client)
      )
        throw new Error("identity");
      let checked: Awaited<ReturnType<InspectToken>> | undefined;
      if (inspect) {
        try {
          checked = await inspect(token);
        } catch {
          throw new MailError("AUTH_SERVICE_UNAVAILABLE", 503);
        }
      }
      if (
        checked &&
        (!checked.active ||
          (checked.sub && checked.sub !== payload.sub) ||
          (checked.exp !== undefined &&
            (!Number.isFinite(checked.exp) ||
              checked.exp * 1000 <= Date.now())))
      )
        throw Error("inactive");
      return {
        principal: {
          tenant,
          subject: payload.sub!,
          client,
          scopes:
            typeof payload.scope === "string"
              ? payload.scope
                  .split(" ")
                  .filter(
                    (s) =>
                      checked?.scope === undefined ||
                      checked.scope.split(" ").includes(s),
                  )
              : [],
        },
        expiresAt: Math.min(
          payload.exp! * 1000,
          checked?.exp !== undefined ? checked.exp * 1000 : Infinity,
        ),
      };
    } catch (e) {
      if (e instanceof MailError) throw e;
      throw new MailError("AUTH_REQUIRED", 401);
    }
  };
}
export async function authentication(c: Config) {
  const settings = await oidc.discovery(
    new URL(c.OIDC_ISSUER),
    c.OIDC_CLIENT_ID,
    c.OIDC_CLIENT_SECRET,
    undefined,
    c.OIDC_ISSUER.startsWith("http:")
      ? { execute: [oidc.allowInsecureRequests] }
      : undefined,
  );
  const metadata = settings.serverMetadata();
  if (
    c.OIDC_INTROSPECTION === "true" &&
    (!metadata.introspection_endpoint ||
      new URL(metadata.introspection_endpoint).origin !==
        new URL(c.OIDC_ISSUER).origin)
  )
    throw Error("Introspection must use configured issuer origin");
  if (
    !metadata.jwks_uri ||
    new URL(metadata.jwks_uri).origin !== new URL(c.OIDC_ISSUER).origin
  )
    throw new Error("OIDC JWKS must use the configured issuer origin");
  const verify = verifier(
    c.OIDC_ISSUER,
    c.OIDC_AUDIENCE,
    c.ALLOWED_CLIENT_IDS.split(",").map((s) => s.trim()),
    createRemoteJWKSet(new URL(metadata.jwks_uri)),
    c.OIDC_INTROSPECTION === "true"
      ? async (token) => oidc.tokenIntrospection(settings, token)
      : undefined,
  );
  return { verify, settings };
}
