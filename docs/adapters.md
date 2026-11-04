# Contribute a mailbox adapter

Start with an issue describing the actual server/API, account types, authentication and provider limitations. A mail client name or domain suffix is not a backend protocol. Reuse IMAP/SMTP, JMAP or optional CardDAV where they already fit; a new adapter should preserve additional provider semantics or cover a missing protocol.

## Follow the existing boundary

1. Implement `MailProvider` in [domain.ts](../src/domain.ts). Its required methods are `verify`, `search`, `get`, `attachment`, `folders`, `mutate` and `send`. Optional extension, native draft, sync and notification methods must match the same interface. [The demo provider](../examples/demo/provider.ts) illustrates the small contract with synthetic data; it is not a network adapter or a production registration example.
2. Declare every `Capabilities` field accurately. Use `unsupported` for absent operations and `emulated` for application behavior. Do not return empty success for an unsupported operation. Preserve folders versus labels, stable message/attachment identity, cursor scope, search coverage and any inferred thread limitations.
3. Add a strict connection variant to `connectionSchema` and `ProviderName` in [domain.ts](../src/domain.ts), then an explicit branch in [factory.ts](../src/providers/factory.ts). The current final factory branch is JMAP: do not allow a new variant to fall through to it. Register no provider credentials in tool inputs or output.
4. Verify mailbox identity before connection succeeds. Preserve encrypted context binding to tenant/owner/account. Central OAuth refresh uses a locked persisted account; provider OAuth flows belong in [provider-oauth.ts](../src/provider-oauth.ts), not in an MCP tool.
5. Use [network.ts](../src/network.ts) for HTTP traffic and approved origin/endpoint policies. Keep TLS verification, bounded responses and credential destination checks. Protocol sockets require their corresponding checked endpoint flow. Do not add redirects, wildcard private-network exceptions or automatic retries of remote writes.
6. Keep account authorization, draft revision/digest approval, idempotency and submission outcome handling in `MailService`. An adapter must not turn an uncertain write into success or a safe-to-retry failure. Calls with a lost final response can represent an already accepted send.

## Tests that make an adapter reviewable

Keep deterministic synthetic test source under `tests/`; start with the closest existing provider suite. Run `npm run check`, `npm run build` and `npm run format:check`. Use the dedicated PostgreSQL fixture for transaction/locking changes. CI also covers browser authority and the OIDC boundary.

Cover identity mismatch, missing scope, unsupported capabilities, provider errors, pagination and invalid cursors, read state, MIME/attachment references, destination credential boundaries, revocation and interrupted submission where applicable. Test real protocol behavior with a loopback server when implementing a protocol. A stubbed HTTP response cannot establish external provider compatibility. Include fixtures for enterprise/shared accounts only when the adapter actually implements them.

Real-account checks are opt-in and deployment-specific. Publish a redacted operation matrix through the compatibility issue form; keep live-account scripts, credentials and generated results outside the repository. Do not make CI require an external mailbox or cloud subscription.

## Review and compatibility

Keep changes small enough to follow from tool input to provider effect. Explain new configuration, scopes, failure behavior and upgrade implications in the PR. Update [provider notes](providers.md), [compatibility](compatibility.md) and API documentation when behavior changes. No schema migration should rely on a destructive startup reset; test existing data and failures before suggesting rollback.
