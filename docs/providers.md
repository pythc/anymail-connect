# Provider configuration

Choose the actual mailbox backend, not the mail client's name or an email suffix. An unrelated mailbox added to the Outlook desktop application is not a Microsoft Graph mailbox. Implemented adapters still require actual provider permissions, protocol configuration and deployment acceptance.

## Gmail and Google Workspace

Create a Web OAuth application for your deployment, enable Gmail API and People API, and register exactly `BASE_URL/oauth/provider/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server, then use `/connect`. The shared-mailbox field is only for Microsoft delegation.

Read-only Gmail connections request `gmail.readonly` and `contacts.readonly`. Writable connections request `gmail.modify` and `contacts`; offline access requests a refresh token. Sending also remains subject to AnyMail account policy, caller scope and exact-message approval. Google consent, app verification and Workspace administrator approval are separate prerequisites. No domain-wide delegation is implemented.

The adapter exposes provider-native search, full messages, MIME parts, labels, threads, contacts and native drafts. New attachment references use stable MIME part IDs and resolve the current provider download handle at read time. Legacy references remain readable where the provider still resolves them.

## Outlook.com and Microsoft 365

Register a Web application in an Entra directory that allows the required account types. Register `BASE_URL/oauth/provider/callback` and configure server-side `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`. Personal and work/school accounts require the appropriate application audience. Application registration requires access to a directory that permits registration.

Global deployments can use `MICROSOFT_CLOUD=global` and `MICROSOFT_TENANT=common`, or restrict to an organization. `usgov`, `usgovdod` and `china` select their static authorization/token/API endpoints; they require the corresponding account and application registration. Personal Outlook accounts use the global environment.

Delegated permissions include `offline_access`, `User.Read`, Mail read/read-write and Contacts read/read-write; send-enabled connections additionally request Mail.Send. A specified delegated shared mailbox uses the appropriate `.Shared` permissions and mailbox route. Actual mailbox access and send rights must be granted by the tenant/Exchange administrator; OAuth consent does not create them. Arbitrary Send As aliases and application-wide mailbox scanning are not offered. Shared-mailbox notifications use periodic reconciliation instead of delegated shared-folder subscriptions.

## IMAP and SMTP

Use explicitly configured hosts, ports and provider-approved credentials. Passwords or application passwords are supported; protocol OAuth is not a universal fallback. Both protocols require implicit TLS or a successful STARTTLS upgrade before credentials. Certificate checks stay enabled. Set `PRIVATE_ENDPOINTS` only for precise approved destinations when needed.

IMAP listing can return headers without downloading oversized bodies; body/attachment reads remain bounded. Reads use non-seen-marking semantics, folder and UIDVALIDITY context is retained, and available server extensions determine move/flag behavior. SMTP sender identity is fixed to the connected email; an IMAP login alone does not prove From ownership, and the SMTP provider must enforce send rights.

## JMAP, CardDAV and EWS

| Protocol | Configuration | Limits |
| --- | --- | --- |
| JMAP | HTTPS session URL and token; optional `JMAP_ALLOWED_ORIGINS` | Advertised API/upload/download origins are checked before credentials are sent; no arbitrary cross-origin fetch |
| CardDAV | Explicit HTTPS collection in optional `carddav` connection settings | Basic credentials, etag-aware writes and a bounded address-book snapshot; no general directory discovery |
| EWS | Explicit HTTPS URL, mailbox and Basic/Bearer authentication; `EWS_ALLOWED_ORIGINS` | Limited on-premises adapter; no NTLM/Kerberos, autodiscovery or organization-wide impersonation |

EWS object identifiers are bound to the account/mailbox/endpoint/type with a server MAC. They are not raw Exchange ItemIds supplied by a caller. Key retirement can invalidate old identifiers; reacquire them through search/sync.

## Native drafts and contacts

Gmail/Graph can export an independent native draft or link native/application drafts for synchronization. Linking defaults to pull; automatic write-back requires explicit opt-in. Conflicts and unknown outcomes stop for inspection rather than replay. Gmail does not provide a verified atomic compare-and-swap for MIME replacement. Graph attachment replacement uses multiple requests with byte read-back; files at or above 3 MB require an upload-session path that is not implemented and are rejected before writing. Other adapters use application drafts instead of pretending to provide atomic native-draft replacement.

Contact behavior is provider-specific. People and Graph use delegated scopes; optional CardDAV covers a specified collection; EWS is restricted to the configured mailbox. An empty contacts response only verifies the empty-list path, not content fidelity or write behavior.

## Notifications

Configure Gmail `GMAIL_PUSH_TOPIC` and `GMAIL_PUSH_IDENTITY` together. Provision a topic in the OAuth application's Google project, grant the Gmail push service publishing permission, and use authenticated Pub/Sub push to `BASE_URL/webhooks/gmail` with that exact audience. The configured identity, signed token claims and notification account are checked.

Graph notifications use `BASE_URL/webhooks/graph`, subscription identity and a persisted random client state. Both providers require reachable callback infrastructure. Owners enable/disable them through `POST /api/push`; inspect `/api/push/:account` or `notifications_status`. A disable with an uncertain remote outcome can leave the remote subscription until expiry while local handling is disabled. IMAP IDLE requires a live worker and a supporting server. Periodic reconciliation remains the fallback; none of these wakes an AI host by itself.
