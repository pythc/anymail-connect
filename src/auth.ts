import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as oidc from "openid-client";
import { MailError, type Principal } from "./domain.js";
import type { Config } from "./config.js";
export type Verified = { principal: Principal; expiresAt: number };
export type Verify = (token: string) => Promise<Verified>;
export function verifier(
  issuer: string,
  audience: string,
  clientIds: string[],
  key: JWTVerifyGetKey,
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
      return {
        principal: {
          tenant,
          subject: payload.sub!,
          client,
          scopes:
            typeof payload.scope === "string" ? payload.scope.split(" ") : [],
        },
        expiresAt: payload.exp! * 1000,
      };
    } catch {
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
    !metadata.jwks_uri ||
    new URL(metadata.jwks_uri).origin !== new URL(c.OIDC_ISSUER).origin
  )
    throw new Error("OIDC JWKS must use the configured issuer origin");
  const verify = verifier(
    c.OIDC_ISSUER,
    c.OIDC_AUDIENCE,
    c.ALLOWED_CLIENT_IDS.split(",").map((s) => s.trim()),
    createRemoteJWKSet(new URL(metadata.jwks_uri)),
  );
  return { verify, settings };
}
