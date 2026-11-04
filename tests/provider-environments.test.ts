import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice } from "./helpers.js";
import { makeFactory } from "../src/providers/factory.js";
import { microsoftClouds } from "../src/providers/microsoft.js";
import { connectionSchema } from "../src/domain.js";
import { ProviderOAuth } from "../src/provider-oauth.js";
import { config } from "../src/config.js";
test("Graph cloud endpoints, token refresh and OAuth state stay in the selected environment", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const [cloud, endpoints] of Object.entries(microsoftClouds))
    await t.test(cloud, async () => {
      const a = await f.store.account(alice, f.account.id);
      const c = connectionSchema.parse({
        provider: "graph",
        cloud,
        email: "test@example.com",
        oauth: {
          accessToken: "expired-lab",
          refreshToken: "refresh-lab",
          clientId: "lab-client",
          clientSecret: "lab-secret",
          tenant: "lab-tenant",
          expiresAt: 1,
        },
      });
      a.provider = "graph";
      a.secret = f.vault.seal(c, `${a.tenant}:${a.owner}:${a.id}`);
      await f.store.updateAccount(a);
      const urls: string[] = [];
      const factory = makeFactory(
        f.store,
        f.vault,
        { privateEndpoints: [] },
        async (url) => {
          urls.push(url);
          return {
            status: 200,
            headers: {},
            body: Buffer.from(
              JSON.stringify(
                url.includes("/token")
                  ? { access_token: "refreshed-lab", expires_in: 3600 }
                  : { mail: "test@example.com" },
              ),
            ),
          };
        },
      );
      assert.equal(
        (await (await factory(a)).verify()).email,
        "test@example.com",
      );
      assert.deepEqual(urls, [
        endpoints.authority + "/lab-tenant/oauth2/v2.0/token",
        endpoints.graph + "/v1.0/me?$select=mail,userPrincipalName",
      ]);
      const settings = config({
        DATABASE_URL: "lab",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        BASE_URL: "https://anymail.invalid",
        OIDC_ISSUER: "https://issuer.invalid",
        OIDC_AUDIENCE: "https://anymail.invalid/mcp",
        OIDC_CLIENT_ID: "web",
        ALLOWED_CLIENT_IDS: "web",
        MICROSOFT_CLOUD: cloud,
        MICROSOFT_CLIENT_ID: "lab-client",
        MICROSOFT_CLIENT_SECRET: "lab-secret",
        MICROSOFT_TENANT: "lab-tenant",
      });
      const url = new URL(
        await new ProviderOAuth(f.service, settings).start(
          alice,
          "graph",
          true,
          true,
        ),
      );
      assert.equal(url.origin, endpoints.authority);
      assert.ok(
        url.searchParams
          .get("scope")
          ?.includes(endpoints.graph + "/Mail.ReadWrite"),
      );
      if (cloud !== "global")
        assert.ok(
          !url.searchParams
            .get("scope")
            ?.includes("https://graph.microsoft.com/"),
        );
      const flow = await f.store.session<{ sealed: string }>(
        "oauth:" + url.searchParams.get("state"),
      );
      assert.equal(
        f.vault.open<any>(
          flow!.sealed,
          "oauth:" + url.searchParams.get("state"),
        ).cloud,
        cloud,
      );
    });
  await t.test(
    "legacy credentials default to global; arbitrary clouds and invalid allowlist entries are rejected",
    () => {
      const legacy = connectionSchema.parse({
        provider: "graph",
        email: "test@example.com",
        oauth: { accessToken: "lab" },
      });
      assert.equal(legacy.provider === "graph" && legacy.cloud, "global");
      assert.throws(() =>
        connectionSchema.parse({
          provider: "graph",
          cloud: "https://evil.invalid",
          email: "test@example.com",
          oauth: { accessToken: "lab" },
        }),
      );
      const env = {
        DATABASE_URL: "lab",
        ENCRYPTION_KEY: "lab",
        BASE_URL: "https://anymail.invalid",
        OIDC_ISSUER: "https://issuer.invalid",
        OIDC_AUDIENCE: "https://anymail.invalid/mcp",
        OIDC_CLIENT_ID: "web",
        ALLOWED_CLIENT_IDS: "web",
      };
      for (const origin of [
        "http://private.invalid",
        "https://allowed.invalid/path",
        "https://allowed.invalid/",
        "https://user@allowed.invalid",
      ])
        assert.throws(() => config({ ...env, JMAP_ALLOWED_ORIGINS: origin }));
      assert.equal(
        config({
          ...env,
          JMAP_ALLOWED_ORIGINS:
            "https://api.allowed.invalid,https://files.allowed.invalid",
        }).JMAP_ALLOWED_ORIGINS.split(",").length,
        2,
      );
    },
  );
});
