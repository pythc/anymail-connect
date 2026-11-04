# Security policy

Scope: MCP and HTTP authentication, object authorization across tenants/users/accounts, provider tokens, mail/attachment handling, network destinations, send consent/idempotency, persistence and rollback. Review reachable evidence, including failures and concurrency. A local protocol lab is not a production certification.

Email content and external provider responses are untrusted data. Any model-visible instruction claiming permission is not authorization. Keep connector credentials out of tools and logs. Permanent mail deletion and arbitrary HTTP fetch are intentionally unavailable.

Do not post credentials, private messages, or exploitable customer data to public issues. Use [GitHub private vulnerability reporting](https://github.com/pythc/anymail-connect/security/advisories/new). Include affected version/digest, a synthetic reproduction, impact and suggested mitigation. The maintainer will triage, coordinate a fix and publish a security advisory when appropriate. There is no guaranteed response time; do not publish exploit details while coordination is ongoing.

Only the newest published development prerelease receives fixes; there is no LTS commitment. Provider and client acceptance is deployment-specific; hosted multi-tenant production readiness and third-party audits are not established. See [architecture](docs/architecture.md) and [operations](docs/operations.md) for the enforced boundaries and deployment obligations.
