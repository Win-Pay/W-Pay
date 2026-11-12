# Disaster recovery

## Objectives

| Scenario | Target RTO | Target RPO |
| --- | --- | --- |
| API pod loss | < 2 min (automatic) | 0 |
| Database primary loss | < 30 min | ≤ 5 min (PITR) |
| Region loss | < 4 h | ≤ 5 min |
| Compromised key | < 1 h to containment | — |

These are targets, not production measurements. The logical restore drill has
been executed in CI and locally (row counts matched). The local restore of the
seeded fixture (5 migrations, 7 users, 4 merchants, 4 invoices) completed in
about 1 second, including scratch database creation and `pg_restore`. That is
not a measure of production RTO, and failover/PITR recovery has not been
measured.

## Backups

- `.github/workflows/backup.yml` takes a daily custom-format `pg_dump` of the
  production database (`DATABASE_URL` secret), records a row-count manifest and
  uploads both as a 30-day artifact.
- `scripts/db-backup.sh` supports client-side encryption for off-site copies:
  set `BACKUP_GPG_RECIPIENT` to a GPG public key and it writes `<dump>.gpg`,
  deletes the plaintext dump and prints the ciphertext SHA-256. The restore
  drill detects `.gpg` files and decrypts with the local secret key. An
  encrypted backup was produced and restored successfully in a local drill on
  2026-11-12.
- The same workflow restores the dump into an ephemeral Postgres and compares
  every count with the manifest, then exercises
  `scripts/db-backup.sh`/`scripts/db-restore-drill.sh` against a freshly
  migrated and seeded database.
- GitHub Actions artifacts are private to the repository but are **not**
  encrypted with the operator key. Production off-site replication should run
  `backup.sh` with `BACKUP_GPG_RECIPIENT` set and upload only the `.gpg` file to
  storage in a different region/account; the private key stays offline.
- This is logical backup only. Managed Postgres continuous WAL archiving/PITR is
  still required in production and is not configured by this repository.
- Contract state does **not** need a backup: it is on the ledger. What matters is
  the ability to rebuild the projection from events.

## Rebuild the projection

If the database is lost or corrupt:

1. Provision a new database, run `pnpm db:migrate`.
2. Recreate merchants and users from your own records (off-chain data is not
   recoverable from chain alone). Restore the last good backup where possible.
3. Reset the indexer checkpoint (`INDEXER_START_LEDGER` to a known ledger before
   the incident) and let it replay events. Upserts are idempotent.
4. Reconcile totals: sum of settled payments minus fees must equal contract
   balances observed via RPC/explorer.

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
1. Compare last checkpoint with chain; if lagging, scale up or reduce interval.
2. If state is wrong, reset the checkpoint and replay; never edit payment rows by
   hand without recording an audit entry.

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
