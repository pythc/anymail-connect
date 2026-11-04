# Contributing

AnyMail Connect is a backend integration service. Keep public documentation and application-owned messages in English; the Chinese README is maintained separately. Synthetic multilingual mail remains useful test coverage.

## Development

Use Node.js 24 or newer and the checked-in lockfile:

```sh
npm ci
npm run check
npm run build
npm run format:check
```

`npm test` creates a short-lived local test certificate and runs synthetic tests using PGlite and loopback protocol servers. Set `TEST_DATABASE_URL` only to a dedicated local PostgreSQL database named `anymail_test*` to exercise the PostgreSQL implementation; each fixture creates and removes an isolated schema.

Browser tests cover provider authorization and human send consent, not a bundled mail client. CI runs `npm run test:browser` and `npm run test:oidc` with Chromium and an isolated Keycloak realm. To run these locally, install the Python dependencies in `tests/requirements-browser.txt`, provision Chromium, and start the synthetic Keycloak fixture for the OIDC layer. `BROWSER_PYTHON` and `CHROMIUM_PATH` select existing local executables. The OCR integration check requires Tesseract.

## What belongs in the repository

Keep production source, synthetic regression tests, deterministic fixtures, deployment templates, the dependency lockfile and maintained operator documentation. Do not commit real mail, live-account scripts or tokens, rendered identity configurations, local backups, generated screenshots/reports, build output or personal implementation checklists. Generated test files belong in ignored `.artifacts/`, `.test-certs/`, `coverage/` or `test-results/`.

When changing an adapter, preserve its capability and coverage statements. Exercise the relevant protocol contract and failure behavior. When changing send, revocation or migration paths, check persisted state, interrupted execution and compatibility as well as the success path. A local fixture is not provider or production certification.

## Community and changes

Use [Discussions](https://github.com/pythc/anymail-connect/discussions) for questions and early designs, and issue forms for bugs, features and compatibility results. Start with a small, reproducible change; read the [adapter guide](docs/adapters.md) for provider work. The maintainer reviews contributions before accepting them. No response-time commitment is implied.

Contributions are submitted under [Apache-2.0](LICENSE). Keep third-party notices and disclose any copied code and its compatible license. Follow the [code of conduct](CODE_OF_CONDUCT.md). Maintained release and upgrade practices are in [release operations](docs/releases.md).
