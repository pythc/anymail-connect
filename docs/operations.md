# Operations

## Backups, upgrades and rollback

Back up PostgreSQL and independently protect the matching application keyring and identity-provider configuration. Credentials cannot be recovered without the encryption keys. Backups also contain private data and require access control and storage encryption. Restore into an isolated database and validate object authority and credentials before returning to service.

Before an upgrade, stop old API/worker processes after allowing in-flight submissions to settle; reconcile `unknown` operations. Keep the prior image, configuration, keyring, database backup and send ledger. Avoid mixed writers across incompatible versions. Runtime migration uses database transactions and version checks; schema version 3 preserves earlier credential, draft and operation records. Executables that do not support the database version refuse startup.

Version 0.4 changes client/browser surfaces without adding a schema version. Its removed dashboard/widget and new authorization route are described in [deployment](deployment.md). The same schema number is not, by itself, proof of full application rollback compatibility.

Only roll back to an executable verified with the current schema, ciphertext format and keyring. A cross-schema rollback requires an isolated conversion/recovery procedure. Never erase operations, reset an unknown submission to approved, recreate its idempotency key or restore an old send-ledger snapshot into an enabled sender. Old-format approval bindings must be cancelled and prepared again, not silently upgraded into consent.

Revoking an account removes live credentials, caches and drafts and cancels work that has not started. Retained audit/operation evidence and historical backups have separate retention. An already issued provider request cannot be reliably recalled.

## Key rotation

1. Stop old writers and back up the current database/keyring.
2. Choose a unique `ENCRYPTION_KEY_ID`, set the new 32-byte base64 `ENCRYPTION_KEY`, and provide old ID-to-key entries in private JSON `ENCRYPTION_PREVIOUS_KEYS`.
3. Give all API/worker nodes the same keyring. Do not reuse an ID for a different key.
4. Run `npm run rotate-keys` for a dry run. It validates existing ciphertext, including records already marked with the active ID.
5. Run `npm run rotate-keys -- --apply`, then repeat the dry run and actual authorized object checks. Rotation can resume without printing plaintext.
6. Retire an old online key only after verification; backups encrypted under it still need that key. EWS references created under retired keys can require reacquisition.

## Retention and extraction

| Setting | Default | Meaning |
| --- | --- | --- |
| `RETENTION_CACHE_DAYS` | `30` | Cache and selected attachment-index snapshots |
| `RETENTION_DRAFT_DAYS` | `0` | Application drafts/uploads; zero disables automatic deletion |
| `RETENTION_AUDIT_DAYS` | `0` | Audit records; zero disables automatic deletion |
| `OCR_ENABLED` | `false` | Allow explicit offline OCR requests |
| `OCR_LANGUAGES` | `eng` | Installed Tesseract languages |
| `IMAP_IDLE_CONNECTIONS` | `8` | Per-worker native listener capacity; zero disables listeners |

The worker protects active/unknown send references, enabled native bindings and required attachments during cleanup. Send-ledger/idempotency data is retained. Cache, drafts and extracted text remain private database content, not encrypted by the credential vault; configure database/backup/disk controls.

Extraction supports bounded text/document formats and optional PNG/JPEG OCR. OCR does not render scanned PDFs, and extraction is not a full-fidelity Office converter or an OS malware sandbox. Attachment search covers only snapshots a user explicitly indexed, not an automatically complete mailbox.

## Failure interpretation

`/healthz` is process liveness only. Check identity access, account capability/policy, actual provider reads, worker state and queue outcomes separately. A valid worker lease is not proof that its remote IMAP handshake succeeded. An expired provider token may require new consent; a network error is not an empty search result.

Web sign-out or token revocation stops subsequent interactions, but does not by itself cancel previously approved scheduled sends or explicitly enabled native-draft write-back. Cancel the operation, stop the binding, revoke the grant or revoke the account as appropriate. Do not enable automatic resend to conceal a network or acknowledgement failure.

Logs and public reports must exclude credentials and mail content. Local test reports, rendered identity files, private acceptance scripts and backups belong outside tracked source. Long-term availability, capacity, disaster recovery and enterprise policy validation remain deployment responsibilities.
