# Disaster recovery

## Objectives

| Scenario | Target RTO | Target RPO |
| --- | --- | --- |
| API pod loss | < 2 min (automatic) | 0 |
| Database primary loss | < 30 min | ≤ 5 min (PITR) |
| Region loss | < 4 h | ≤ 5 min |
| Compromised key | < 1 h to containment | — |

These are targets, not production measurements. The logical restore drill has
been executed locally through the Docker fallback (no local `pg_restore`), so it
skipped archive TOC validation; on 2026-11-22 it restored every public table
(21 tables plus `_prisma_migrations`), compared all row counts and the applied
`_prisma_migrations` set, and matched all 8 migrations after AES-256 decryption.
The workflow's verify job runs `pg_restore --list` and compares the restored
migration set with the manifest captured at dump time, but the workflow itself
has not run. This is not a measure of production RTO, and failover/PITR recovery
has not been measured.

## Backups

- `.github/workflows/backup.yml` is configured to take a daily custom-format
  `pg_dump` of the production database, encrypt it with AES-256 before upload,
  write a SHA-256 sidecar, and record a full table-count manifest, the exact
  applied migration list and metadata as artifacts retained for 30 days.
- **Current state (2026-11-22): production backup is BLOCKED.** The last
  scheduled run (`45008774752`, commit `9f0fd10`) failed at preflight because
  the `production` environment has no `DATABASE_URL`. The environment exists but
  has no protection rules. The workflow now also requires
  `BACKUP_GPG_PASSPHRASE` and refuses to create an unencrypted dump. Neither
  secret is readable with the current token, so no production backup has been
  taken. The hardened workflow (mandatory encryption, exact migration-set
  comparison, failure alert) has not yet run on GitHub. The 2026-11-22 local
  drill passed and is recorded above, but it is not production evidence.
- The workflow has four jobs:
  - **backup**: preflight, dump, encryption, row-count manifest, migration
    manifest, metadata, artifact upload.
  - **verify-backup**: checksum, decrypt, `pg_restore --list`, restore into an
    ephemeral Postgres, compare every table count and the exact applied
    migration set, then fail on any mismatch.
  - **restore-drill**: migrates and seeds a separate ephemeral Postgres, backs it
    up through `scripts/db-backup.sh` with a throwaway CI-only passphrase, then
    restores through `scripts/db-restore-drill.sh`. It has no dependency on the
    production dump or production secrets, so it validates encryption,
    checksums and restore even when production secrets are absent.
  - **notify-failure**: on any failed job, opens or comments on a single
    `Scheduled database backup failed` issue with the run link, job results and
    the required secret names. It never prints secret values.
- Preflight fails closed when `DATABASE_URL`, `BACKUP_GPG_PASSPHRASE`, `pg_dump`,
  `psql` or `gpg` is missing. A plaintext production dump is never uploaded.
- `scripts/db-backup.sh` always writes a `.sha256` sidecar and rejects an empty
  or unreadable custom-format archive before publishing it. `pg_restore --list`
  validates the archive TOC when the client is installed.
- Encryption modes:
  - `BACKUP_GPG_PASSPHRASE` uses symmetric AES-256 with a loopback passphrase.
    This is the mode the CI workflow uses because the same secret can decrypt
    for automatic verification.
  - `BACKUP_GPG_RECIPIENT` uses a GPG public key and keeps the private key
    offline. It is supported by the script for manual/off-site copies, but the
    CI verify job cannot decrypt recipient-only backups; providing the private
    key to GitHub Actions is not recommended.
  - Both modes write `<dump>.gpg`, remove the plaintext dump and checksum the
    ciphertext. An encrypted round-trip and retention pruning were verified
    locally on 2026-11-22; the workflow's encryption path has not run against
    production.
- `BACKUP_RETENTION_DAYS` prunes only `wpay-*.dump`, `.dump.gpg` and their
  `.sha256` sidecars older than the cutoff in the output directory. It does not
  touch unrelated files. The workflow does not configure retention pruning
  because artifacts are already retained for 30 days.
- GitHub Actions artifacts are private to the repository but are **not** a
  substitute for encrypted off-site storage. Production off-site replication
  should upload only the ciphertext plus `.sha256` to storage in a different
  region/account; the passphrase stays in the secret store and an offline
  password manager.
- This is logical backup only. Managed Postgres continuous WAL archiving/PITR is
  still required in production and is not configured by this repository.
- Contract state does **not** need a backup: it is on the ledger. What matters is
  the ability to rebuild the projection from events.

### Enabling production backups

An operator with repository administration and the `production` environment must
do this once:

1. Create or confirm the `production` environment under **Settings >
   Environments**. Set **Deployment branches** to `main` so other branches cannot
   read its secrets.
2. Create a least-privilege database role for backups (read-only is sufficient
   for `pg_dump`; use provider-specific read roles where available) and copy its
   connection string, including TLS parameters required by the provider.
3. Generate a long random passphrase and store it in an offline password manager.
   Do not commit it or paste it into an issue:
   ```bash
   openssl rand -base64 48
   ```
4. Store both values as **environment** secrets, not repository secrets,
   because the workflow declares `environment: production`. `gh secret set`
   prompts without echoing the value:
   ```bash
   gh secret set DATABASE_URL --env production
   gh secret set BACKUP_GPG_PASSPHRASE --env production
   ```
   The same `BACKUP_GPG_PASSPHRASE` value must remain available for restore
   verification and any later restore from these artifacts.
5. Run the workflow manually and wait for all jobs:
   ```bash
   gh workflow run backup.yml --ref main
   gh run watch
   ```
   Acceptance: `backup`, `verify-backup` and `restore-drill` succeed; the
   artifact contains only `wpay.dump.gpg`, its `.sha256`, `manifest.txt`,
   `migrations.txt` and `backup-metadata.txt`; the verify log reports matching
   row counts and `OK migrations=<count> applied`.
6. Only after that run succeeds may the production backup item be marked PASS.
   A local drill or a green `restore-drill` job alone does not prove that the
   production database can be backed up or restored.

## Rebuild the projection

If the database is lost or corrupt:

1. Provision a new database, run `pnpm db:migrate`.
2. Recreate merchants and users from your own records (off-chain data is not
   recoverable from chain alone). Restore the last good backup where possible.
3. Reset each configured contract checkpoint with
   `POST /v1/admin/indexer/replay` (`fromLedger` before the incident) and call it
   again until `done:true`, or run the indexer normally from
   `INDEXER_START_LEDGER`. Replayed inserts are idempotent.
4. Check `GET /v1/admin/indexer/consistency` and reconcile totals: sum of settled
   payments minus refunds and fees must equal contract balances observed via
   RPC/explorer. `GET /v1/admin/settlements/reconciliation` reports unallocated
   payable amounts and window mismatches.

## Incident procedures

### Suspected key compromise
1. Pause contracts via `emergency-pause` (or `POST /admin/pause` to build the tx).
2. Rotate `JWT_SECRET`, database password, API keys, `SOROBAN_SOURCE_SECRET`.
3. Revoke the compromised role/address; move treasury funds to a new address via
   the treasury contract's authorized path.
4. Preserve logs and audit entries; do not destroy evidence.

### API outage
1. Check `/v1/health` and pod events; roll back the last release if correlated.
2. Payments already signed by users remain valid on-chain regardless of API
   state; communicate the tx hash path (`POST /transactions/submit`).
3. If the indexer is healthy, no payment is lost — only visibility.

### Indexer drift
1. Compare the last checkpoint with chain; if lagging, scale up or reduce the
   interval. `GET /v1/admin/indexer/consistency` flags stale configured
   contracts and unresolved failures.
2. If state is wrong, call `POST /v1/admin/indexer/replay` with a ledger before
   the divergence and repeat until `done:true`; never edit payment rows by hand
   without recording an audit entry.
3. If an automatic settlement batch is stuck, inspect
   `GET /v1/admin/settlements/automation`; correct the cause before an `ADMIN`
   clears its backoff with `POST /v1/admin/settlements/:id/retry`.

## Communication

Status page + merchant email for incidents affecting payment confirmation.
Never state that funds are safe without verifying contract balances.

## Gaps

- No automated failover or chaos testing is configured here.
- No PITR/WAL archiving automation. Encryption and the restore drill are
  implemented, but scheduled off-site upload to a second region/account is an
  operator deployment task.
- No on-call rotation, runbook ownership or incident tooling is included.
- The RTO/RPO values above are targets; only the local logical-restore wall time
  has been measured.
