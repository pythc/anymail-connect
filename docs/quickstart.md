# Try the synthetic mailbox

This local demo exercises the real HTTP/MCP gateway, PostgreSQL state, OIDC login, revisioned drafts and browser approval. A separate synthetic adapter supplies two fictional messages and simulates submission. It never constructs a real mailbox adapter, has no provider credentials, and rejects new mailbox/OAuth connections. Docker uses an ordinary bridge with outbound connectivity; mailbox isolation comes from the separate adapter, not a network firewall. The stored `imap` provider label is a schema placeholder, not an IMAP compatibility result.

## Start

Install Docker Compose v2 and Node.js 24+. Use the source archive from a [prerelease](https://github.com/pythc/anymail-connect/releases) or clone its exact tag. Ports **4480–4482** must be available. No cloud account, billing setup or real mailbox is needed.

```sh
node scripts/demo.mjs init
docker compose --env-file .artifacts/demo/compose.env -f examples/demo/compose.yaml up -d --wait
node scripts/demo.mjs walk
```

`init` uses the package version's prebuilt GHCR image by default. To pin the release's immutable digest, set `ANYMAIL_IMAGE=ghcr.io/pythc/anymail-connect@sha256:...` **before** running `init`. For source development, build an image first and set `ANYMAIL_IMAGE=anymail-connect:local`. The demo never builds an image automatically.

Open `.artifacts/demo/login.txt` locally for the generated demo password. Do not paste it into an issue. Open the sign-in URL printed by `walk`, log in as `demo`, and return to the terminal. The script searches for an invoice, reads it, creates a draft and prepares its exact revision. It then prints:

1. The browser sign-in URL, which establishes the separate HttpOnly approval session using the same OIDC account.
2. The approval URL. Open it **after** signing in, inspect the complete message, and click **Approve this exact message**.

The script waits for the persisted operation to reach `provider_accepted`. Here that means **the simulation accepted it; no mail was delivered**. The CLI does not approve the operation. Tokens stay in its process memory. Login expires after three minutes; approval polling ends after four minutes. On timeout, inspect the existing operation before creating another one.

## Connect an MCP client

The demo exposes Streamable HTTP at `http://localhost:4480/mcp`. It requires a valid OIDC token for `anymail-demo-cli`, the `http://localhost:4480/mcp` audience, and the required mail scopes. `walk` demonstrates a public-client authorization-code flow with PKCE and the exact loopback callback `http://127.0.0.1:4482/callback`. A client with another callback needs a deliberately configured client registration. Hosts without access to your loopback interface cannot use this demo. This is not a ChatGPT connection walkthrough or a Registry listing.

The normal endpoints `/api/call/:tool`, `/connect`, `/approve/:id` and authenticated source views remain available. There is no mailbox dashboard. Use [the API reference](api.md) for manual calls; never share bearer tokens.

## Stop, restart and reset

```sh
docker compose --env-file .artifacts/demo/compose.env -f examples/demo/compose.yaml down
# Later: run the same up command to retain accounts, drafts and operations.
```

`init` refuses an existing directory so it cannot silently replace encryption keys for persisted data. Keep `.artifacts/demo/` with the demo database. The synthetic identity is reimported at startup; it is not a durable production identity service. To discard this demo completely, run the same `down` command with **`--volumes`**, then remove **only** `.artifacts/demo/`. This deletes the isolated `anymail-demo` database, never another deployment's volume. Do not use reset instructions on real mail data.

All published ports bind to `127.0.0.1`. The Docker network defaults to `10.253.251.0/28`; set `DEMO_SUBNET` to an unused private subnet if it conflicts with your routes or containers. Generated files are ignored by Git, the directory is mode 0700 and secret files are 0600. The realm file is 0644 inside that protected directory so Keycloak's unprivileged container user can read it. Do not expose this development stack through a tunnel or reverse proxy.

## Move to real mail

Create a separate deployment following [deployment](deployment.md) and [provider configuration](providers.md), with HTTPS, a durable identity service, independent database and new keys. The normal API/worker entrypoints never import the demo adapter. Provider OAuth, enterprise consent, callback reachability and operational recovery remain separate acceptance work.
