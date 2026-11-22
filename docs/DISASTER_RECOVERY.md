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
skipped archive TOC validation; it restored every public table, compared all row
counts plus the applied `_prisma_migrations` set and matched 8 migrations in
about 1 second including scratch database creation. The workflow's verify job
runs `pg_restore --list`, but the workflow itself has not run. This is not a
measure of production RTO, and failover/PITR recovery has not been measured.

## Backups

- `.github/workflows/backup.yml` is configured to take a daily custom-format
  `pg_dump` of the production database (`DATABASE_URL` secret), write a SHA-256
  sidecar, record a full table-count manifest plus metadata and upload them as a
  30-day artifact. Its verify job validates the archive TOC
  (`pg_restore --list`) after decryption.
- **Current state (2026-11-13):** the scheduled run fails closed at the dump
  step because the `DATABASE_URL` repository secret is not configured (run
  43401586650), so no automatic production backup has been taken yet. Add
  `DATABASE_URL` to enable the daily dump and restore verification.
- `scripts/db-backup.sh` always writes a `.sha256` sidecar and rejects an empty
  or unreadable custom-format archive before publishing it.
- Encryption is optional but recommended for off-site copies:
  - `BACKUP_GPG_RECIPIENT` uses a GPG public key (private key stays offline).
  - `BACKUP_GPG_PASSPHRASE` uses symmetric AES-256 with a loopback passphrase
    (use a long, randomly generated secret stored in the workflow secret
    store).
  Both modes write `<dump>.gpg`, remove the plaintext dump and checksum the
  ciphertext. A local encrypted backup was produced and restored successfully
  on 2026-11-22, and the workflow's optional `BACKUP_GPG_PASSPHRASE` path is
  exercised by the restore-drill job.
- `BACKUP_RETENTION_DAYS` prunes only `wpay-*.dump`, `.dump.gpg` and their
  `.sha256` sidecars older than the cutoff in the output directory. It does not
  touch unrelated files.
- The workflow has three jobs: **backup** (dump, manifest, metadata, artifact),
  **verify** (checksum, decrypt, TOC, restore, all-table count comparison), and
  **restore-drill** (backup a freshly migrated/seeded database, then run the
  restore script against the dump). The restore-drill job has no dependency on
  the production dump, so it still validates the scripts when the `DATABASE_URL`
  secret is absent. All jobs fail closed on checksum, decryption or count
  mismatch.
- GitHub Actions artifacts are private to the repository but are **not**
  encrypted unless the backup itself was. Production off-site replication should
  run `backup.sh` with encryption and upload only the ciphertext plus `.sha256`
  to storage in a different region/account; the private key or passphrase stays
  offline.
- This is logical backup only. Managed Postgres continuous WAL archiving/PITR is
  still required in production and is not configured by this repository.
- Contract state does **not** need a backup: it is on the ledger. What matters is
  the ability to rebuild the projection from events.

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
