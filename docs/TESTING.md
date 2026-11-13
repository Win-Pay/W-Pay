# Testing

## Contract tests

```bash
pnpm contracts:test
```

140 tests across 18 test binaries run on the Soroban test host: 138 behaviour
tests plus two `WPAY_BENCH` resource tests (payment creation and a 20-entry
settlement execution). They cover access control, pause behaviour, state
transitions, fee math, overflow, nested auth, and cross-contract calls.
Snapshot files under `test_snapshots/` record ledger/auth intersections for key
scenarios.

Run the benchmarks and show their output with:

```bash
cargo test --manifest-path packages/contracts/Cargo.toml -- --nocapture \
  payment_resource_usage settlement_resource_usage
```

Known pitfall: `mock_all_auths()` does not satisfy nested auth when a
non-root contract authorizes the outer call. Refund tests therefore authorize
with the merchant settlement address explicitly.

Integration tests (`packages/contracts/integration-tests`) run as part of the
same `cargo test` invocation.

## TypeScript tests

```bash
pnpm test
```

230 tests pass and 2 are skipped, across six packages:

| Package | Tests | Focus |
| --- | --- | --- |
| `@wpay/api` | 164 | Access rules, API keys, cookie/CSRF session refresh with rotation and reuse revocation, production config fail-closed checks, validation, error envelope, rate-limit stores, webhook signature/retry/DLQ and concurrent claim, URL guard, settlement batches, memo-bound payment/invoice verification, merchant fee/ownership enforcement, plus real-Postgres integration flows for payments, refunds, subscriptions and webhooks |
| `@wpay/indexer` | 29 | Event decoding, projections for every domain, `jsonSafe`, token hashing, checkpoints, durable/expired cursors, dead-letter retry/recovery |
| `@wpay/sdk` | 13 | HTTP client (credentials included, CSRF header, no refresh token in body), automatic refresh retry, call builders (including settlement windows), Soroban gateway, wallet signers |
| `@wpay/shared` | 10 | Cursor encoding, webhook HMAC/verification, wallet messages, error mapping |
| `@wpay/e2e` | 10 (+2 skipped) | Env-name mapping vs `.env.example`, fee/amount parity, call construction, wallet message, webhook tamper tests; live-API tests skip unless `WPAY_E2E_API_URL` is set |
| `@wpay/database` | 4 | Cursor paging, bigint serialization, migration helpers |

Without `DATABASE_URL`, the Postgres-backed files report as skipped rather than
failing. To execute them all:

```bash
DATABASE_URL=postgresql://wpay:wpay@localhost:5432/wpay?schema=public \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=test-secret-that-is-long-enough-for-validation \
RATE_LIMIT_PER_MINUTE=100000 \
pnpm test
```

Integration tests create their own users, merchants and invoices and clean up
afterwards. They require a reachable Postgres and run real transactions and
rollbacks.

### Coverage

```bash
DATABASE_URL=... JWT_SECRET=... pnpm --filter @wpay/api test:coverage
```

Measured 2026-11-13: **89.4% statements**, 71.12% branches, 92.48% functions.
Payment module 90.03%, invoices 91.95%, operations (refunds/subscriptions)
91.49%, platform 91.97%, auth 90.76%. The 80% overall / 90% money-path targets
are enforced by review, not by a coverage threshold in CI.

### Playwright browser flow

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

Five Chromium tests drive the checkout and landing pages with a mocked Freighter
provider and mocked API routes: a missing wallet is reported instead of paying,
merchant details and the fee split are shown before signing, a normal
connect/sign/submit sequence submits exactly one transaction and shows the
confirmed hash with a receipt and Explorer link, a `FAILED` submission surfaces
an error without marking the invoice paid, and `/landing` renders separately
without replacing checkout. Measured 2026-11-13: 5 passed (46.3 s, after
installing Chromium and its system libraries). The CI `browser` job runs the
same suite. These tests exercise the UI and wallet adapter contract; they do not
load the real Freighter extension or submit to Testnet.

## Soroban resource measurements

Local metering uses the test host's cost estimate, so the numbers are
reproducible without network access:

```bash
cargo test --manifest-path packages/contracts/Cargo.toml -- --nocapture \
  payment_resource_usage settlement_resource_usage
```

Measured 2026-11-12:

| Operation | CPU instructions | Memory bytes | Read entries / bytes | Write entries / bytes | Event bytes | Resource fee (stroops) |
| --- | --- | --- | --- | --- | --- | --- |
| `payment.create` | 38,015 | 7,538 | 0 / 0 | 0 / 0 | 0 | 27 |
| `settlement.execute` (20 entries) | 4,200,606 | 753,222 | 1 / 92 | 24 / 7,420 | 4,872 | 24,780,075 (incl. 24,647,887 rent) |

The test-host fee is a local estimate; it is not the network charge. Note the
rent component of the 20-entry settlement: a 50-entry batch exceeded the test
host's budget in `auth.rs`, which is why the API caps batches at 20 entries.

Real Testnet numbers, including transaction size and network simulation:

```bash
pnpm measure:testnet
```

The script reads `deployments/testnet.json` and `deployments/testnet-e2e.json`,
verifies the recorded payment over RPC/Horizon, then simulates a fresh
`create_payment` with the public payer account. It loads no secret, signs
nothing and submits nothing. Measured 2026-11-12:

| Measurement | Value |
| --- | --- |
| Recorded payment fee charged | 82,589 stroops |
| Recorded payment envelope / result / meta | 1,896 / 64 / 8,036 bytes |
| Simulated `create_payment` CPU | 2,419,372 instructions |
| Simulated disk read / write | 372 / 1,532 bytes |
| Simulated minimum resource fee | 83,770 stroops |
| Unsigned / assembled envelope | 308 / 1,840 bytes |
| Assembled transaction fee field | 83,870 stroops |

The fee difference between the recorded transaction and the simulation reflects
different ledger state (footprint and auth entries), not a fixed price. Re-run
the script to refresh the values.

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
compares row counts for the core and new tables (including indexer failures and
settlement batches) and always drops the scratch database. It passes locally
against the compose Postgres in about 1 second for the seeded fixture.
`.github/workflows/backup.yml` runs a daily production dump, restores it into an
ephemeral Postgres and compares every row count with the manifest captured at
dump time. Set `BACKUP_GPG_RECIPIENT` to encrypt an off-site copy
(`scripts/db-backup.sh` writes `<dump>.gpg` and deletes the plaintext); the
drill decrypts `.gpg` dumps with the matching secret key. Encrypted round-trip
verified locally 2026-11-12.

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
4. `GET /v1/health` → `database: "up"`, `soroban: "up"`, contract flags.
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
- The real Freighter extension in a browser. The Playwright suite mocks the
  provider; the adapter and signing helpers are unit tested.
- Real-wallet Testnet submission from the browser (the API-side Testnet E2E is
  recorded in `deployments/testnet-e2e.json`).
- Real Freighter extension behaviour and any Mainnet operation.
- Cluster deployment, live Prometheus scraping/alert delivery, Argo sync, image
  signing and the deploy workflow, which require infrastructure credentials.
- Long-running incident drills and chaos scenarios; backup/restore and encrypted
  backup round-trips are automated, but failover RTO/RPO is not measured.

GitHub Actions runs on commit `3b197b0` (2026-11-12) succeeded for both `CI`
and `Security`: Soroban contracts, TypeScript workspace, Rust dependency audit,
browser wallet flow, indexer/API container builds, k6 load test, CodeQL,
Trivy and Gitleaks. Dependency review is a pull-request-only job and was
skipped on the push. Image signing runs in the deploy workflow and was not
executed.
