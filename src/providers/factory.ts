import type { Store } from "../store.js";
import { Vault } from "../crypto.js";
import {
  MailError,
  type Account,
  type Connection,
  type MailProvider,
  type Principal,
} from "../domain.js";
import {
  httpClient,
  type HttpRequest,
  type NetworkPolicy,
  providerError,
} from "../network.js";
import { Rest } from "./rest.js";
import { GmailProvider } from "./gmail.js";
import { GraphProvider } from "./graph.js";
import { ImapProvider } from "./imap.js";
import { JmapProvider } from "./jmap.js";
import { microsoftClouds } from "./microsoft.js";
import { CardDav } from "./contacts.js";
import { EwsProvider } from "./ews.js";
export type ProviderFactory = (account: Account) => Promise<MailProvider>;
export function makeFactory(
  store: Store,
  vault: Vault,
  policy: NetworkPolicy,
  http: HttpRequest = httpClient(policy),
  jmapOrigins: string[] = [],
  ewsOrigins: string[] = [],
): ProviderFactory {
  return async (account) => {
    const context = `${account.tenant}:${account.owner}:${account.id}`;
    const connection = vault.open<Connection>(account.secret, context);
    const configured = (provider: MailProvider) => {
      if (connection.carddav) {
        const dav = new CardDav(connection.carddav, http),
          extension = provider.extension?.bind(provider);
        provider.capabilities = {
          ...provider.capabilities,
          contacts: "native",
        };
        provider.extension = (op, i) =>
          op.startsWith("contacts.")
            ? dav.run(op, i)
            : extension
              ? extension(op, i)
              : Promise.reject(new MailError("UNSUPPORTED_CAPABILITY", 422));
      }
      return provider;
    };
    const p: Principal = {
      tenant: account.tenant,
      subject: account.owner,
      client: "worker",
      scopes: [],
    };
    const token = async () =>
      store.db.transaction(async (tx) => {
        const current = await store.account(p, account.id, tx, true),
          c = vault.open<Connection>(current.secret, context);
        if (c.provider !== "gmail" && c.provider !== "graph")
          throw new MailError("WRONG_PROVIDER");
        const o = c.oauth;
        if (!o.expiresAt || o.expiresAt > Date.now() + 60_000)
          return o.accessToken;
        if (!o.refreshToken || !o.clientId)
          throw new MailError("PROVIDER_AUTH_REQUIRED", 401);
        const endpoint =
          c.provider === "gmail"
            ? "https://oauth2.googleapis.com/token"
            : `${microsoftClouds[c.cloud ?? "global"].authority}/${encodeURIComponent(o.tenant)}/oauth2/v2.0/token`;
        const r = await http(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: o.clientId,
            refresh_token: o.refreshToken,
            ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
          }).toString(),
        });
        if (r.status !== 200) providerError(r.status);
        const t = JSON.parse(r.body.toString());
        if (!t.access_token || !Number.isFinite(t.expires_in))
          throw new MailError("INVALID_TOKEN_RESPONSE", 502);
        c.oauth = {
          ...o,
          accessToken: t.access_token,
          refreshToken: t.refresh_token || o.refreshToken,
          expiresAt: Date.now() + t.expires_in * 1000,
        };
        current.secret = vault.seal(c, context);
        await store.updateAccount(current, tx);
        return c.oauth.accessToken;
      });
    if (connection.provider === "gmail")
      return configured(
        new GmailProvider(
          new Rest("https://gmail.googleapis.com/gmail/v1", token, http),
          connection.email,
          new Rest("https://people.googleapis.com/v1", token, http),
        ),
      );
    if (connection.provider === "graph")
      return configured(
        new GraphProvider(
          new Rest(
            microsoftClouds[connection.cloud ?? "global"].graph + "/v1.0",
            token,
            http,
          ),
          connection.mailbox,
          connection.email,
        ),
      );
    if (connection.provider === "imap")
      return configured(new ImapProvider(connection, policy));
    if (connection.provider === "ews")
      return configured(
        new EwsProvider(
          connection,
          http,
          ewsOrigins,
          vault.authenticationKeys(
            `ews:${account.tenant}:${account.owner}:${account.id}`,
          ),
        ),
      );
    return configured(new JmapProvider(connection, http, jmapOrigins));
  };
}
