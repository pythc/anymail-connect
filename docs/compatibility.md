# Compatibility and evidence

Evidence is scoped to an operation and environment. Implementation, synthetic contract tests and real-account acceptance are different claims. This is a development prerelease; no hosted production certification is asserted.

| Adapter / account type | Reproducible evidence in this repository | Real-account evidence | Remaining acceptance |
| --- | --- | --- | --- |
| Gmail personal | Native API, MIME, attachment IDs, People and OAuth fixtures | Maintainer-reported private read-only checks: search pagination, selected messages/threads, labels, attachments, token refresh and native draft listing; empty contacts path only | Write, send, contact content/write; network reliability |
| Gmail-enabled Workspace | Same native adapter and contract tests | None recorded | Organization consent, real tenant policy and operations |
| Outlook.com | Graph/OAuth fixtures | None recorded | App registration, personal-account consent and operations |
| Microsoft 365 | Graph, shared mailbox, tenant/cloud routing fixtures | None recorded | Tenant registration, delegated/shared grants and real operations in each cloud |
| IMAP/SMTP personal or enterprise | Loopback TLS/STARTTLS protocol tests, UID/folder/read-state and SMTP failure paths | None recorded for a named external provider | Each provider/server/version, extensions, sender authorization and send behavior |
| JMAP | Synthetic session/API/upload/download and origin-boundary fixtures | None recorded | Named server/version and real credentials |
| EWS on-premises | Synthetic SOAP/identifier/auth-boundary fixtures | None recorded | Approved Exchange version, authentication, permissions and real operations |
| Optional CardDAV | Synthetic collection/contact/etag fixtures | None recorded | Named server, collection and real contact operations |
| Synthetic demo | OIDC + PostgreSQL + HTTP workflow; fake mailbox and submission | Not applicable | Does not test a provider protocol or delivery |

Private Gmail checks were performed against the 0.4 development line. They are not public reproducible evidence or an endorsement from Google. Intermittent outbound TLS resets were observed; a later successful read does not establish reliability. No private addresses, message contents, tokens or live-account scripts are published.

| Client / transport | Evidence | Limit |
| --- | --- | --- |
| HTTP gateway | Synthetic regression and demo workflow | Does not establish a particular AI host's UX |
| MCP SDK / Streamable HTTP | Synthetic tool discovery, tool calls, authenticated attachment resources and authorization tests | Tested SDK version is locked in `package-lock.json` |
| Browser consent / source views | Chromium fixture tests and real synthetic Keycloak login/introspection tests | Minimal authority endpoints, no mailbox frontend |
| ChatGPT | Not accepted against AnyMail | Official Gmail/Outlook connectors do not transfer OAuth tokens to this service |
| Other MCP hosts | No named host/version acceptance recorded | Client OAuth, resources/files and source rendering vary |

## Report a compatibility result

Use the [compatibility issue form](https://github.com/pythc/anymail-connect/issues/new?template=compatibility.yml). Include exact AnyMail tag/digest, provider and server version, personal/enterprise/shared account type, client and version, transport, scopes, operations attempted, expected/observed outcomes and a redacted reproduction. Report read-only and write/send separately. For send, distinguish provider acceptance from delivery and record interrupted/unknown behavior without repeating the submission.

Do not attach real messages, addresses, tokens, tenant IDs or credential files. Synthetic evidence is preferred. A result becomes a maintained compatibility claim only after review; one passing deployment is not evidence for all accounts from that provider.
