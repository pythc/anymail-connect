# Security policy

Scope: MCP and HTTP authentication, object authorization across tenants/users/accounts, provider tokens, mail/attachment handling, network destinations, send consent/idempotency, persistence and rollback. Review reachable evidence, including failures and concurrency. A local protocol lab is not a production certification.

Email content and external provider responses are untrusted data. Any model-visible instruction claiming permission is not authorization. Keep connector credentials out of tools and logs. Permanent mail deletion and arbitrary HTTP fetch are intentionally unavailable.

Do not post credentials, private messages, or exploitable customer data to public issues. Use GitHub private vulnerability reporting when enabled by the repository owner. No private reporting address is asserted before one is configured.

0.1.0 is a development release. Real provider/ChatGPT acceptance, hosted multi-tenant deployment and third-party audits are pending; see TODO.md and docs/implementation.zh-CN.md.
