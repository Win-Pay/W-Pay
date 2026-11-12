# Testing

## Contract tests

```bash
pnpm contracts:test
```

138 tests across 18 test binaries run on the Soroban test host. They cover
access control, pause behaviour, state transitions, fee math, overflow, nested
auth, and cross-contract calls. Snapshot files under `test_snapshots/` record
ledger/auth intersections for key scenarios.

Known pitfall: `mock_all_auths()` does not satisfy nested auth when a
non-root contract authorizes the outer call. Refund tests therefore authorize
with the merchant settlement address explicitly.

Integration tests (`packages/contracts/integration-tests`) run as part of the
same `cargo test` invocation.

## TypeScript tests

```bash
pnpm test
```

188 tests pass and 2 are skipped, across six packages:

| Package | Tests | Focus |
| --- | --- | --- |
| `@wpay/api` | 130 | Access rules, API keys, validation, error envelope, rate-limit stores, webhook signature/retry/DLQ, URL guard, plus real-Postgres integration flows for payments, refunds, subscriptions, webhooks and blockchain confirmation |
| `@wpay/indexer` | 23 | Event decoding, projections for every domain, `jsonSafe`, token hashing, checkpoints |
| `@wpay/sdk` | 11 | HTTP client, call builders, Soroban gateway, wallet signers |
| `@wpay/shared` | 10 | Cursor encoding, webhook HMAC/verification, wallet messages, error mapping |
| `@wpay/e2e` | 10 (+2 skipped) | Env-name mapping vs `.env.example`, fee/amount parity, call construction, wallet message, webhook tamper tests; live-API tests skip unless `WPAY_E2E_API_URL` is set |
| `@wpay/database` | 4 | Cursor paging, bigint serialization, migration helpers |

Integration tests create their own users, merchants and invoices and clean up
afterwards. They require a reachable Postgres and run real transactions and
rollbacks; when Postgres is unavailable the files skip rather than fail.

### Coverage

```bash
DATABASE_URL=... JWT_SECRET=... pnpm --filter @wpay/api test:coverage
```

Measured 2026-11-12: **89.23% statements**, 69.77% branches, 92.24% functions.
Payment module 90%, invoices 91.48%, operations (refunds/subscriptions) 91.27%,
auth 94.57%. The 80% overall / 90% money-path targets are enforced by review,
not by a coverage threshold in CI.

## Testnet end-to-end

```bash
node scripts/deploy-testnet.cjs    # idempotent; verifies/creates the 16 contracts
node scripts/e2e-testnet.cjs       # idempotent; settles payment 1 or verifies it
```

The E2E script deploys a Stellar Asset Contract, creates trustlines through
Horizon, mints test tokens, initializes FeeManager/MerchantRegistry/PaymentRouter,
registers and approves a merchant, and submits `create_payment`. It asserts
transaction `SUCCESS`, `get_payment` status `Settled`, exact treasury/merchant
balances, and the `payment` event contents. Results are recorded in
`deployments/testnet-e2e.json`; re-running verifies the recorded payment instead
of creating a second one.

This is Testnet only. It is not a mainnet test and does not constitute an audit.

## Load test

```bash
# API running with a high RATE_LIMIT_PER_MINUTE
NODE_PATH=apps/api/node_modules node loadtest/seed.cjs > /tmp/k6.env
k6 run -e BASE_URL=http://127.0.0.1:4000 \
  -e EMAIL=... -e PASSWORD=... -e INVOICE=... loadtest/wpay.k6.js
```

`loadtest/wpay.k6.js` runs read traffic (health + public invoice lookup) and a
separate 1 login/second scenario, so bcrypt CPU use does not distort read
latency. Thresholds: failed requests <1%, health p95 <500 ms, invoice lookup
p95 <600 ms, login p95 <2.5 s, checks >99%. The `loadtest` job in
`.github/workflows/ci.yml` seeds data against a service Postgres and fails the
build on threshold breach.

## Backup and restore drill

```bash
POSTGRES_PASSWORD=... pnpm db:backup
POSTGRES_PASSWORD=... pnpm db:restore-drill
```

`scripts/db-restore-drill.sh` creates a scratch database, restores the dump,
compares row counts for the core tables and always drops the scratch database.
It passes locally against the compose Postgres. `.github/workflows/backup.yml`
runs a daily production dump, restores it into an ephemeral Postgres and
compares every row count with the manifest captured at dump time.

## Build and type checks

```bash
pnpm typecheck
pnpm build
pnpm lint
```

`pnpm build` builds API, indexer, the three Next apps, the mobile PWA and the
extension. `@stellar/stellar-sdk` is pinned to 16.4.1 across the workspace.

Environment for all commands:

```bash
export DATABASE_URL="postgresql://wpay:wpay@localhost:5432/wpay?schema=public"
export JWT_SECRET="test-secret-that-is-long-enough-for-validation"
export REDIS_URL="redis://localhost:6379"   # optional; falls back to in-memory
```

## Manual smoke test with Testnet contracts

1. Start Postgres and Redis, run migrations and seed.
2. Export the `CONTRACT_*_ID` values from `deployments/testnet.json`.
3. `pnpm dev`.
4. `GET /v1/health` → `database: "up"`, `soroban: "configured"`, contract flags.
5. Create a merchant and invoice, look it up in checkout, pay it on Testnet, then
   `POST /v1/invoices/public/:number/confirm` with the transaction hash.
6. The invoice becomes `PAID` and the payment `SETTLED` only after the API
   verifies the on-chain transaction. A bogus hash or mismatched amount returns
   `400` and leaves the invoice `OPEN`.

## Docker and infrastructure checks

```bash
JWT_SECRET=... docker compose config --quiet
docker build -f infra/docker/api.Dockerfile -t wpay-api:ci .
helm lint helm/wpay && helm template wpay helm/wpay >/dev/null
kubeconform -strict -summary k8s/*.yaml
```

Base images are pinned by digest in Dockerfiles, compose and CI. The deploy
workflow adds provenance/SBOM attestations and signs images with cosign
keyless OIDC, then verifies signatures before Helm upgrade.

## What is not tested

- Mainnet execution, real funds, or any external audit.
- Wallet extension interaction (Freighter) — the adapter and signing helpers are
  unit tested, but no browser drives the extension.
- Browser E2E (no Playwright suite).
- Long-running incident drills and chaos scenarios; backup/restore is automated.
