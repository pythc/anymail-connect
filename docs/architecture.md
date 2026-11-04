# Architecture

AnyMail Connect separates client interaction from provider authority. The MCP or HTTP consumer owns its interface. The server owns identity checks, account policy, state transitions, credentials and network access. The browser is used only where a human or provider authorization boundary requires it.

## Components

| Component | Responsibility |
| --- | --- |
| `app.ts`, `auth.ts`, `mcp.ts` | HTTP/MCP transport, OIDC, session and request protection |
| `tools.ts`, `enhancements.ts` | Shared tool schemas and entry points |
| `service.ts`, `store.ts`, `crypto.ts` | Account authorization, private objects, send state and encrypted credentials |
| `providers/` | Provider-specific mail/contact capabilities and protocol contracts |
| `sync.ts`, `idle.ts`, `push.ts`, `change-queue.ts` | Checkpoints, event hints, leases and periodic reconciliation |
| `native-drafts.ts`, `maintenance.ts` | Native-draft synchronization, conflict stops and retention |
| `extract.ts`, `extract-worker.mjs` | Bounded attachment extraction and optional OCR |

API and worker are separate processes sharing PostgreSQL and the same keyring. The API serves requests and browser consent. The worker submits approved due operations, renews notifications, reconciles mailboxes, processes native drafts and cleans eligible retained data. A worker error defers work while preserving durable state.

## Identity and account policy

Every authenticated principal has a trusted tenant, immutable subject, allowed client ID and scopes. JWT checks enforce issuer, resource audience, expiry and client allowlisting. Optional introspection additionally checks active state and narrows scopes; failure does not fall back to an offline allow.

Authorization combines the caller scope with account ownership or an unexpired same-tenant grant and the account's `writable`/`sendEnabled` policy. Granting a scope cannot grant a capability the connection has disabled. Connection credentials remain owner-managed. Application drafts, uploads and attachment indexes are private to their user; native provider drafts remain mailbox content.

Browser sessions are encrypted in the store, expire with their token, and use HttpOnly/SameSite cookies. Cookie-authenticated mutations require CSRF protection. Bearer tools cannot submit a browser approval. Mail and attachment contents are untrusted data, not instructions or authority.

## Sending

An application draft has a revision. Preparing a send creates a persisted operation bound to the actor/client, sending account, exact draft revision, content, delivery schedule and attachment byte identity. An idempotency key identifies the existing operation rather than creating a new send.

The user opens `approval_url`; the server renders sender, recipients including Bcc, body and attachment hashes. Approval requires a browser session, CSRF and the prepared digest. The worker may submit an approved operation as soon as it is due. Submission reacquires account authority and checks the frozen binding.

States include `pending`, `approved`, `submitting`, `provider_accepted`, `unknown`, `cancelled` and `failed`. A missing acknowledgement or interrupted submission can become `unknown`. Unknown submissions are not automatically replayed. Revocation can stop work not yet submitted; it cannot recall an in-flight provider request. Provider acceptance is not delivery confirmation.

## Provider and network boundaries

Adapters expose capabilities and coverage instead of pretending labels, folders, search queries or native drafts are interchangeable. Gmail/Graph use fixed native API bases; JMAP cross-origin resources and EWS origins require administrator policy. CardDAV uses an explicitly configured collection.

Outbound HTTP requires HTTPS, validates all resolved target addresses and ports, pins an approved address, and keeps certificate validation. Exact administrator `PRIVATE_ENDPOINTS` entries permit selected enterprise endpoints. Redirects are not followed automatically. The optional operator HTTP(S) proxy receives an already-approved IP for CONNECT, preserving the original Host and TLS identity. It does not authorize private targets or provide automatic direct fallback. Raw IMAP/SMTP, OIDC and host-file import do not use that proxy setting.

## Storage and processing

Provider credentials and sessions are encrypted with a versioned keyring and object context. This does not encrypt the entire database: synchronized content, drafts and extracted indexes require deployment-level database, backup and disk access controls. See [operations](operations.md).

Sync results describe their actual coverage and cursors. Cache/index results cover retained snapshots only. IDLE and authenticated push notifications are change hints feeding a durable coalescing queue; periodic reconciliation remains available. A worker lease does not establish a live remote connection, and a notification does not initiate an AI conversation.

Attachment extraction has byte, time and worker limits. Optional OCR is explicit and offline. These limits are not an operating-system malware sandbox. High-risk hosting needs additional process/container isolation and measured capacity controls.

## Acceptance boundary

Synthetic unit, HTTP, database and protocol tests establish specific contracts. Deployment-specific provider consent, enterprise policies, shared permissions, host installation, sustained availability, load, disaster recovery and cross-version rollback need separate evidence. The project does not assert general hosted multi-tenant production readiness or official-provider feature parity.
