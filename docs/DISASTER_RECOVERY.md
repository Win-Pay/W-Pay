# Disaster recovery

## Objectives

| Scenario | Target RTO | Target RPO |
| --- | --- | --- |
| API pod loss | < 2 min (automatic) | 0 |
| Database primary loss | < 30 min | ≤ 5 min (PITR) |
| Region loss | < 4 h | ≤ 5 min |
| Compromised key | < 1 h to containment | — |

These are targets, not measured results; no drill has been run in this
repository.

## Backups

- Managed Postgres continuous WAL archiving + daily snapshots, 30-day retention.
- Weekly restore into an isolated environment; verify row counts for
  `Payment`, `Merchant`, `WebhookDelivery` and the latest migration.
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

- No automated failover, backup verification or chaos testing is configured here.
- No on-call rotation, runbook ownership or incident tooling is included.
