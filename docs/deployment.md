# Deployment

Run the API and worker with PostgreSQL and a separately provisioned OIDC provider. The checked-in Compose file starts the application and database; it does not provision identity or public TLS. Use private configuration, not checked-in credentials.

## Configure identity and secrets

1. Copy `.env.example` to `.env`. Generate independent random secrets with `node scripts/secrets.mjs`; save the output securely. Replace every placeholder.
2. Set an HTTPS origin in `BASE_URL`, and set `OIDC_AUDIENCE` to exactly `BASE_URL/mcp`. `OIDC_ISSUER` must be the same externally and from the containers. HTTP loopback is accepted only outside production mode.
3. Register the confidential `OIDC_CLIENT_ID` with an exact callback of `BASE_URL/auth/callback`. Use authorization code with PKCE; disable password grants. Set its secret in `OIDC_CLIENT_SECRET`.
4. Register each MCP client separately with its exact host-provided callback, PKCE and appropriate client authentication. Add its client ID to `ALLOWED_CLIENT_IDS`.
5. Tokens must include trusted `tenant_id`, immutable `sub`, `azp` or `client_id`, `scope`, expiry and the resource audience. Tenant identity must not be user-editable. Grant `mail.read`, `mail.write` and `mail.send` independently.

`deploy/keycloak-realm.template.json` is a single-realm reference, with no default users or passwords. Set `BASE_URL`, `OIDC_CLIENT_SECRET`, `ANYMAIL_TENANT_ID` and `CHATGPT_REDIRECT_URI`, then run:

```sh
node scripts/render-config.mjs
```

The private rendered realm is written to ignored `.artifacts/anymail-realm.json`. Import it using your identity provider's controlled lifecycle. The template includes explicit subject/tenant/audience mappings. Multi-tenant hosting requires a trusted tenant-identity design rather than accepting caller-supplied tenant values.

Optional `OIDC_INTROSPECTION=true` requires a same-issuer-origin introspection endpoint and usable confidential-client authentication. Invalid/revoked tokens and introspection outages fail closed. Existing sessions without a sealed access token require a new login.

## Start the service

```sh
docker compose build
docker compose up -d
```

The sample exposes the API on `127.0.0.1:3000` and persists PostgreSQL in a named volume. Put it behind a correctly configured HTTPS reverse proxy preserving the original Host. Unconditional `trustProxy` is disabled. Use a URL-encoded password in a manually constructed `DATABASE_URL`; the sample Compose database password convention is random hex.

`GET /` returns service metadata. `GET /healthz` reports process liveness, not identity/provider readiness. Run the worker for queued submission, synchronization, notification renewal, native-draft processing and retention.

## Connect mailboxes

Configure provider applications as described in [providers](providers.md). Open `BASE_URL/connect`, sign in and authorize Gmail or Microsoft. Read-only is the default; changes and sending are explicit opt-ins. The provider callback is exactly `BASE_URL/oauth/provider/callback`, distinct from the MCP client's OIDC callback.

Other providers use authenticated `POST /api/accounts/connect` with a validated connection object; examples are in the [API reference](api.md). Keep password/token JSON in private files or a secret manager. Do not place it in shell history, screenshots, issues or plugin packages.

## Network policy

- `PRIVATE_ENDPOINTS` is an exact comma-separated `host:port` allowlist for approved enterprise services or a compatible local Bridge. Configure trusted certificates; it never disables TLS.
- `JMAP_ALLOWED_ORIGINS`, `EWS_ALLOWED_ORIGINS` and `HOST_FILE_ORIGINS` accept exact canonical HTTPS origins with no path, userinfo, query or fragment. They are administrator configuration, not connection-user input. Origin and network checks are independent.
- `OUTBOUND_PROXY_URL` optionally selects a trusted HTTP(S) CONNECT proxy for provider HTTP APIs and provider OAuth. URL userinfo can authenticate to the proxy. The target is checked and locally resolved first; CONNECT uses a selected approved IP, preferring IPv4, without automatic alternate-address retry. Original Host/SNI and certificate validation remain active.
- Raw IMAP/SMTP, OIDC and host-file downloads remain direct. There is no automatic redirect following or fallback to direct access after proxy failure.

In Docker, `localhost` is the container. Docker Desktop can use `host.docker.internal` for an existing host proxy only if that proxy accepts container connections. Proxy availability and destination-IP tunneling must be tested in the actual environment. Do not change global network or TLS settings to hide a deployment failure.

## Register an MCP client

The endpoint is `BASE_URL/mcp`; discovery is at `BASE_URL/.well-known/oauth-protected-resource`. Configure the host with its pre-registered OAuth client and exact callback. Request only the scopes needed for the workflow. A cloud host cannot use your computer's `localhost` URL without a separately supported, authorized connectivity arrangement.

`plugin/` contains reference connection metadata for an independently hosted endpoint. Replace the template deployment URL when packaging. Do not embed static Authorization headers, mailbox credentials or OAuth secrets. The package is not a published or universally installable product; host permissions and installation need separate verification.

## Upgrading from the bundled UI

Version 0.4 removes the mailbox dashboard and the `ui://anymail/preview` MCP App. The root route is JSON; provider authorization moves to `/connect`, and the related OIDC/provider callbacks return there. Mail and draft tools, HTTP operations, authenticated attachment resources, source URLs and send approval remain available. Notification `manage_url` points to the authenticated account-status API. Clients must not depend on the removed HTML/widget resources.

This change introduces no database migration. Follow [operations](operations.md) before any rollout; a source update or passing test does not update a private deployment automatically.
