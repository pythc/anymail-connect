# HTTP and MCP API

The MCP endpoint and HTTP gateway use the same tool registry, input schemas and service authorization. Use MCP `tools/list` as the authoritative schema inventory. Results declare provider capability, coverage, cursors and partial failures; clients must preserve those distinctions.

## Authentication

Use an OIDC bearer token with the configured issuer, exact resource audience and an allowed client ID. `mail.read`, `mail.write` and `mail.send` are separate permissions, further limited by ownership/grants and connection policy. Managing a connection requires `mail.write` even if the mailbox being connected is read-only.

Browser sessions are available for provider OAuth, authenticated source links and human approval. Cookie-authenticated HTTP mutations require `x-csrf-token` from `GET /api/me`. `/api/oauth/start` requires that browser session as well as CSRF; a bearer token alone does not create a provider browser flow. `POST /approve/:id` explicitly rejects bearer authorization.

## HTTP gateway

Assume `ANYMAIL_BASE_URL` identifies your deployment and `ANYMAIL_ACCESS_TOKEN` is obtained through its configured identity provider. Keep the token in private runtime configuration.

```sh
curl --fail-with-body "$ANYMAIL_BASE_URL/api/call/accounts_list" \
  -H "Authorization: Bearer $ANYMAIL_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{}'
```

Search a selected account by replacing `ACCOUNT_UUID`:

```sh
curl --fail-with-body "$ANYMAIL_BASE_URL/api/call/messages_search" \
  -H "Authorization: Bearer $ANYMAIL_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"account_id":"ACCOUNT_UUID","search":{"query":"invoice","limit":10}}'
```

HTTP results are the tool's native JSON value; MCP additionally returns it in `structuredContent`, wrapping array values in `{ "items": [...] }`. MCP tool errors set `isError`; HTTP errors use status codes and error JSON. Unavailable data must not be represented by a fabricated empty success.

| Tool family | Representative tools |
| --- | --- |
| Account and policy | `profile`, `accounts_list`, `accounts_capabilities`, `data_policy`, `accounts_grants`, `accounts_grant`, `accounts_revoke_grant` |
| Mail | `messages_search`, `messages_get`, `messages_batch_get`, `folders_list`, `messages_modify`, `messages_batch_modify` |
| Citations | `search`, `fetch` |
| Drafts and send | `drafts_create`, `drafts_get`, `drafts_list`, `drafts_update`, `drafts_delete`, `drafts_reply`, `drafts_prepare_send`, `drafts_send`, `operations_get`, `operations_cancel` |
| Native drafts | `drafts_save_native`, `native_drafts_bind`, `native_drafts_list`, `native_drafts_inspect`, `native_drafts_sync`, `native_drafts_stop` |
| Attachments | `attachments_list`, `attachments_get`, `attachments_read`, `attachments_export`, `attachments_import_file`, `attachments_index`, `attachments_search`, `attachments_unindex` |
| Sync and provider operations | `sync_page`, `cache_search`, `notifications_status`, `provider_extension`, `unsubscribe_info`, `unsubscribe_prepare` |

Provider extensions remain named, schema-validated operations with provider-specific permissions. Never infer write authority from a tool name, model suggestion or email instruction.

## MCP client

This example uses the MCP SDK already declared by this project:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "mail-consumer", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${process.env.ANYMAIL_BASE_URL}/mcp`),
    { requestInit: { headers: {
      authorization: `Bearer ${process.env.ANYMAIL_ACCESS_TOKEN}`,
    } } },
  ));
  const result = await client.callTool({ name: "accounts_list", arguments: {} });
  if (result.isError) throw new Error("Mailbox lookup failed");
  console.log(result.structuredContent);
} finally {
  await client.close();
}
```

Production consumers must obtain/refresh their OIDC token through the registered flow rather than hardcoding tokens. Tool annotations are hints; server authorization remains decisive. No `ui://` resource or embedded MCP app is registered.

## Connect a protocol mailbox

`POST /api/accounts/connect` accepts `{ connection, writable, sendEnabled }` and verifies the connection before persisting it. `writable` and `sendEnabled` default to false. An IMAP example body is:

```json
{
  "connection": {
    "provider": "imap",
    "email": "user@example.com",
    "username": "user@example.com",
    "password": "PROVIDER_APPROVED_SECRET",
    "imap": { "host": "imap.example.com", "port": 993, "secure": true },
    "smtp": { "host": "smtp.example.com", "port": 465, "secure": true },
    "saveSentCopy": true
  },
  "writable": false,
  "sendEnabled": false
}
```

Use provider-approved real settings in a private file and submit its bytes only to your own deployment. Do not copy example hosts or credentials into production. Connection schemas also support JMAP and administrator-approved EWS; see `connectionSchema` in `src/domain.ts` and [provider notes](providers.md). Revoke with `POST /api/accounts/revoke` and `{ "account_id": "ACCOUNT_UUID" }`.

## Attachments and source links

`attachments_export` returns an authenticated `resource_link`; MCP clients read it through `resources/read`. The resource URI binds account, message and attachment. `attachments_get` returns an authenticated download URL. File resources use the current user's account authority and do not mint public bearer links or official OpenAI file IDs.

Uploads use `POST /api/upload` with `{ account_id, name, type, content }`, where `content` is bounded base64. A selected host file can instead use `attachments_import_file` only when its HTTPS origin is administrator-approved in `HOST_FILE_ORIGINS`. The host must support the relevant standard resource/file behavior.

`search` produces source IDs for `fetch`. Browser source URLs render escaped text at `/message/:account/:message` after login. These are source views, not a mailbox UI. Reopen the source or approval URL after signing in if needed.

## Approval and submission

1. Create or update a draft and retain its exact `revision`.
2. Call `drafts_prepare_send` with `account_id`, `draft_id`, `revision`, a stable `idempotency_key`, and optional ISO `due_at`.
3. Ask the user to open the returned `approval_url` and review the complete message and attachments. Tools do not submit the browser approval form.
4. The worker processes approved due operations. `drafts_send` may submit only an already approved operation; `operations_get` reports its persisted outcome.

Do not generate a new key or operation to retry `unknown`/interrupted submissions. Independent native-draft exports and explicit write-back are remote writes even though they do not send email.

## Notifications and administrative state

`GET /api/push/:account` and `notifications_status` expose an authorized snapshot, including reconciliation fallback. Notification `manage_url` points to that status API. `POST /api/push` takes `{ account_id, action: "enable" | "disable" }` and requires the connection owner with read/write authority. Provider callback endpoints are infrastructure endpoints, not mailbox tools. See [providers](providers.md) for their authentication and setup requirements.
