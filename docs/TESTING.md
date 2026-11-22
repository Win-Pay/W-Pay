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

263 tests pass and 2 are skipped, across seven packages:

| Package | Tests | Focus |
| --- | --- | --- |
| `@wpay/api` | 190 | Access rules, API keys, cookie/CSRF session refresh with rotation and reuse revocation, production config fail-closed checks, validation, error envelope, rate-limit stores, webhook signature/retry/DLQ and concurrent claim, URL guard, settlement batches, memo-bound payment/invoice verification, merchant fee/ownership enforcement, settlement executor open/add/close/execute, resume, budget and mismatch paths, automatic settlement claiming/backoff/reconciliation, indexer replay/consistency endpoints, plus real-Postgres integration flows for payments, refunds, subscriptions, settlements, indexer operations and webhooks |
| `@wpay/indexer` | 31 | Event decoding, projections for every domain, terminal-state protection on replay, `jsonSafe`, token hashing, checkpoints, durable/expired cursors, dead-letter retry/recovery, bounded historical replay, consistency invariants |
| `@wpay/sdk` | 14 | HTTP client (credentials included, CSRF header, no refresh token in body, GET query never sent as a body), automatic refresh retry, call builders (including settlement windows), Soroban gateway, wallet signers |
| `@wpay/hooks` | 4 | Freighter network passphrase/name matching and refusal to sign on a mismatched network |
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

Measured 2026-11-22 on the current checkout: **88.25% statements**, 71.87%
branches, 91.36% functions. The settlement executor is 90.42% statements after
adding parser and execute-path tests. The 80% overall / 90% money-path targets
are enforced by review, not by a coverage threshold in CI.

### Playwright browser flow

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:browser
```

Nine Chromium tests run in three projects, each against its own Next dev server
built once by `tests/playwright/prepare.mjs`:

- **checkout** (5): the customer app with a mocked Freighter provider and mocked
  API routes. A missing wallet is reported instead of paying, merchant details
  and the fee split are shown before signing, a normal connect/sign/submit
  sequence submits exactly one transaction and shows the confirmed hash with a
  receipt and Explorer link, a `FAILED` submission surfaces an error without
  marking the invoice paid, and `/landing` renders separately without replacing
  checkout.
- **merchant** (2): signs in, shows merchant status/fee/registry and API-backed
  analytics, switches to the Payments tab and renders the payment row; a rejected
  sign-in shows an error instead of an empty dashboard.
- **admin** (2): signs in, shows health and indexer failure counts; a `USER`
  account is refused operator access.

Measured 2026-11-22: 9 passed (2.1 min, Playwright 1.65 with the cached
Chromium build). The CI `browser` job runs the same suite. These tests exercise
the UI and wallet adapter contract; they do not load the real Freighter
extension or submit to Testnet.

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

The isolated invoice suite is separate from the 16-contract record:

```bash
DEPLOYMENTS_FILE=deployments/testnet-invoice-deployments.json \
SECRET_FILE=.env.testnet-invoice.local \
CONTRACTS=feeManager,merchantRegistry,paymentRouter,invoiceManager,settlementManager \
node scripts/deploy-testnet.cjs

NODE_PATH=packages/sdk/node_modules node scripts/e2e-invoice-testnet.cjs
```

It deploys five contracts, creates a test SAC, registers and approves a
merchant, creates invoice `2`, pays it, and verifies the `invoice`, `payment`
and `paid` events plus exactly equal balance deltas. It then exercises two
settlement windows, an underfunded simulation rejection and a duplicate
execution rejection. Results are in
`deployments/testnet-invoice-e2e.json`. Negative cases and their limitations are
listed in [TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md#negative-tests-2026-11-22).

The same events were replayed into a scratch Postgres database and processed by
the real API indexer and settlement worker in `execute` mode. That run created
and executed automation window `4` with four `SUCCESS` Soroban transactions,
resolved four expected dead letters through the operator endpoint, and a stable
second pass inserted nothing and created no duplicate. The record is
`deployments/testnet-invoice-automation.json`. This was a supervised local API
process against Testnet, not the hosted Vercel deployment.

This is Testnet only. It is not a mainnet test and does not constitute an audit.
The payment was signed by generated keypairs through the SDK, not by the real
Freighter extension.

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

`scripts/db-restore-drill.sh` validates the `.sha256` sidecar (or
`EXPECTED_SHA256`), checks the archive TOC when `pg_restore` is installed (and
warns when only the Docker fallback is available), creates a scratch database,
restores the dump, compares row counts for every public table dynamically and
compares the applied `_prisma_migrations` set, then always drops the scratch
database. A clean local run on 2026-11-22 against the stable test database
restored all 21 public tables plus `_prisma_migrations`, matched all eight
applied migrations, and passed after AES-256 passphrase decryption. The backup
ciphertext SHA-256 was `c30370a3726d98d260fb91a1125a3e2197256383ccd59b9b2a4928c8f9ce5eda`.
The local run still skipped TOC validation because `pg_restore` is not installed;
the workflow verify job performs it.
`.github/workflows/backup.yml` runs a daily production dump, fails preflight
unless `DATABASE_URL` and `BACKUP_GPG_PASSPHRASE` are configured as `production`
environment secrets, restores the encrypted dump into an ephemeral Postgres and
compares every row count and the exact applied migration set with the manifests
captured at dump time; its verify job runs `pg_restore --list`. The
`restore-drill` job is independent of production and exercises the scripts
against a migrated/seeded database. A `notify-failure` job opens or updates one
`Scheduled database backup failed` issue with job results and the required
secret names, never their values. For manual copies, `BACKUP_GPG_RECIPIENT`
(public-key) or `BACKUP_GPG_PASSPHRASE` (symmetric AES-256) is supported;
`scripts/db-backup.sh` writes `<dump>.gpg`, deletes the plaintext and writes a
ciphertext `.sha256`. The drill decrypts either form. Encrypted round-trip and
retention pruning were verified locally on 2026-11-22.
The production backup/verify jobs have not run because `DATABASE_URL` and
`BACKUP_GPG_PASSPHRASE` are absent from the production environment. The last
scheduled run (`45008774752`, commit `9f0fd10`) failed at preflight with
`DATABASE_URL secret is not configured`. The independent `restore-drill` job
runs against an ephemeral Postgres, but the hardened workflow (mandatory
encryption, migration-set comparison, failure issue) has not run on GitHub yet.
A local drill is not a production backup.

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
  provider; the adapter and signing helpers are unit tested. The Testnet invoice
  run used generated keypairs through the SDK.
- Real-wallet Testnet submission from the browser (the API-side Testnet E2E runs
  are recorded in `deployments/testnet-e2e.json` and
  `deployments/testnet-invoice-e2e.json`, but neither loads Freighter).
- The hosted deployment running migration `0008` and the settlement-automation
  routes: `GET /v1/admin/settlements/automation` returned `404` when checked on
  2026-11-22. The automation Testnet run used a local API process.
- A production backup: the local encrypted restore drill passes, but the
  scheduled workflow fails closed for missing production secrets.
- Cluster deployment, live Prometheus scraping/alert delivery, Argo sync, image
  signing and the deploy workflow, which require infrastructure credentials.
- Long-running incident drills and chaos scenarios; backup/restore and encrypted
  backup round-trips are automated, but failover RTO/RPO is not measured.

The latest recorded remote green run is code commit `89aa100` (2026-11-22):
CI run 45074675192 and Security run 45074675203 succeeded, including the Soroban
`clippy -D warnings` gate, 140 Rust tests, both resource benchmarks, the WASM
build, TypeScript workspace, browser wallet flow, indexer/API container builds,
k6 load test, CodeQL, Trivy, Gitleaks and the dependency audit. All 11 check runs
completed and none was skipped on push. Dependency review now lives in
`.github/workflows/dependency-review.yml`, runs only on pull requests (the
correct trigger for `actions/dependency-review-action`) and will be exercised by
the next PR rather than appearing as a skipped push check. Image signing runs in
the deploy workflow and was not executed.
