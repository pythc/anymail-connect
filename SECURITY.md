# Security policy

Scope: MCP and HTTP authentication, object authorization across tenants/users/accounts, provider tokens, mail/attachment handling, network destinations, send consent/idempotency, persistence and rollback. Review reachable evidence, including failures and concurrency. A local protocol lab is not a production certification.

Email content and external provider responses are untrusted data. Any model-visible instruction claiming permission is not authorization. Keep connector credentials out of tools and logs. Permanent mail deletion and arbitrary HTTP fetch are intentionally unavailable.

Do not post credentials, private messages, or exploitable customer data to public issues. Use GitHub private vulnerability reporting when enabled by the repository owner. No private reporting address is asserted before one is configured.

0.4.0 is a development release. Provider and client acceptance is deployment-specific; hosted multi-tenant production readiness and third-party audits are not established. See [architecture](docs/architecture.md) and [operations](docs/operations.md) for the enforced boundaries and deployment obligations.
