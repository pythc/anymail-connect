import { createHash } from "node:crypto";
import { microsoftClouds, type MicrosoftCloud } from "./providers/microsoft.js";
import { opaque } from "./crypto.js";
import { MailError, requireScope, type Principal } from "./domain.js";
import type { MailService } from "./service.js";
import type { Config } from "./config.js";
import { httpClient, providerError } from "./network.js";
type State = {
  p: Principal;
  verifier: string;
  provider: "gmail" | "graph";
  writable: boolean;
  sendEnabled: boolean;
  mailbox?: string;
  cloud?: MicrosoftCloud;
};
export class ProviderOAuth {
  constructor(
    private service: MailService,
    private c: Config,
  ) {}
  private options(provider: "gmail" | "graph", cloud = this.c.MICROSOFT_CLOUD) {
    if (provider === "gmail")
      return {
        clientId: this.c.GOOGLE_CLIENT_ID,
        clientSecret: this.c.GOOGLE_CLIENT_SECRET,
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
      };
    return {
      clientId: this.c.MICROSOFT_CLIENT_ID,
      clientSecret: this.c.MICROSOFT_CLIENT_SECRET,
      authorize: `${microsoftClouds[cloud].authority}/${this.c.MICROSOFT_TENANT}/oauth2/v2.0/authorize`,
      token: `${microsoftClouds[cloud].authority}/${this.c.MICROSOFT_TENANT}/oauth2/v2.0/token`,
    };
  }
  async start(
    p: Principal,
    provider: "gmail" | "graph",
    writable: boolean,
    sendEnabled: boolean,
    mailbox?: string,
  ) {
    requireScope(p, "mail.write");
    if (sendEnabled) requireScope(p, "mail.send");
    if (sendEnabled && !writable)
      throw new MailError("SEND_REQUIRES_WRITE_POLICY");
    const cloud = this.c.MICROSOFT_CLOUD,
      graph = microsoftClouds[cloud].graph;
    const o = this.options(provider, cloud);
    if (!o.clientId || !o.clientSecret)
      throw new MailError("PROVIDER_OAUTH_NOT_CONFIGURED", 503);
    const state = opaque(),
      verifier = opaque();
    const value = {
      p,
      verifier,
      provider,
      writable,
      sendEnabled,
      mailbox,
      cloud,
    };
    await this.service.store.setSession(
      "oauth:" + state,
      { sealed: this.service.vault.seal(value, "oauth:" + state) },
      new Date(Date.now() + 600_000).toISOString(),
    );
    const params = new URLSearchParams({
      client_id: o.clientId,
      redirect_uri: `${this.c.BASE_URL}/oauth/provider/callback`,
      response_type: "code",
      scope:
        provider === "gmail"
          ? writable
            ? "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts"
            : [
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/contacts.readonly",
                ...(sendEnabled
                  ? ["https://www.googleapis.com/auth/gmail.send"]
                  : []),
              ].join(" ")
          : [
              "offline_access",
              `${graph}/User.Read`,
              `${graph}/Mail.${writable ? "ReadWrite" : "Read"}${mailbox ? ".Shared" : ""}`,
              ...(sendEnabled
                ? [`${graph}/Mail.Send${mailbox ? ".Shared" : ""}`]
                : []),
              `${graph}/Contacts.${writable ? "ReadWrite" : "Read"}${mailbox ? ".Shared" : ""}`,
            ].join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(provider === "gmail"
        ? { access_type: "offline", prompt: "consent" }
        : {}),
    });
    return o.authorize + "?" + params;
  }
  async callback(p: Principal, state: string, code: string) {
    const record = await this.service.store.consumeSession<{ sealed: string }>(
      "oauth:" + state,
    );
    if (!record) throw new MailError("OAUTH_STATE_INVALID", 403);
    const s = this.service.vault.open<State>(record.sealed, "oauth:" + state);
    if (s.p.subject !== p.subject || s.p.tenant !== p.tenant)
      throw new MailError("OAUTH_IDENTITY_MISMATCH", 403);
    const cloud = s.cloud ?? "global";
    const o = this.options(s.provider, cloud),
      http = httpClient({ privateEndpoints: [] });
    const r = await http(o.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: o.clientId!,
        client_secret: o.clientSecret!,
        redirect_uri: `${this.c.BASE_URL}/oauth/provider/callback`,
        code,
        code_verifier: s.verifier,
      }).toString(),
    });
    if (r.status !== 200) providerError(r.status);
    const token = JSON.parse(r.body.toString());
    if (!token.access_token || !Number.isFinite(token.expires_in))
      throw new MailError("INVALID_TOKEN_RESPONSE", 502);
    const endpoint =
      s.provider === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : microsoftClouds[cloud].graph +
          "/v1.0/me?$select=mail,userPrincipalName";
    const identity = await http(endpoint, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (identity.status !== 200) providerError(identity.status);
    const profile = JSON.parse(identity.body.toString()),
      email =
        s.mailbox ??
        profile.emailAddress ??
        profile.mail ??
        profile.userPrincipalName;
    return this.service.connect(
      p,
      {
        provider: s.provider,
        email,
        ...(s.provider === "graph"
          ? { cloud, ...(s.mailbox ? { mailbox: s.mailbox } : {}) }
          : {}),
        oauth: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
          clientId: o.clientId,
          clientSecret: o.clientSecret,
          tenant: this.c.MICROSOFT_TENANT,
        },
      },
      s.writable,
      s.sendEnabled,
    );
  }
}
