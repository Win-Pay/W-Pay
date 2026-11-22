# Final engineering report

Date: 2026-11-12, updated 2026-11-22 after the automatic-settlement, indexer
replay, backup-verification, CI and contributor-readiness pass
Repository: `/workspaces/W-Pay`
Scope: gap closure against the engineering brief, run on the existing W-Pay
monorepo without rebuilding or replacing working modules.

This report is an acceptance record, not an audit opinion and not evidence of a
mainnet launch. Every result below was produced by a command or query in this
workspace; deployment identifiers live in [DEPLOYMENTS.md](../DEPLOYMENTS.md).

> **Later state (2026-11-13, residual-risk pass).** The API, Postgres and Redis
> are hosted on Vercel/Neon/Upstash; webhook delivery and indexing are caught
> up by the Vercel daily cron plus a 15-minute GitHub Actions job
> (`.github/workflows/maintenance.yml`); per-account login lockout and nonce
> CSP are deployed; and refund approval can be signed after linkage via
> `POST /v1/refunds/:id/approve-transaction`. Statements below that say the
> backend is not hosted, or that an unlinked refund always returns `409`,
> describe the earlier snapshot.
>
> **Latest state (2026-11-22).** Section 8 supersedes earlier test counts,
> coverage, settlement-worker, indexer-replay and backup statements. The new
> migration and API code are local only; the hosted deployment has not been
> migrated or redeployed.

## 1. What changed

| Area | Change |
| --- | --- |
| Testnet deployment | Deployed the four contracts missing from the earlier 12 and verified all 16 ids, upload/create transactions and WASM hashes; replaced the draft deployment table with records generated from `deployments/testnet.json` |
| On-chain confirmation | API confirmation requires a `SUCCESS` result for the expected contract call and amount; bogus hashes and mismatched amounts leave the invoice `OPEN` |
| Indexer | Event ingestion, checkpoints, payment/refund/escrow/settlement projections documented in [INDEXER.md](INDEXER.md); idempotent upserts; durable `IndexerFailure` dead letters with automatic retry and admin visibility; transaction hash and contract ids persisted |
| Postgres integration tests | Real Postgres suites for auth, merchants, invoices, payments, webhooks and on-chain write paths, using transactions and cleanup |
| Coverage | API coverage **89.4% statements**, with money paths at 90.03% (payments), 91.95% (invoices), 91.49% (operations), 91.97% (platform settlements), 90.76% (auth) |
| Rate limiting | Redis-backed store used when `REDIS_URL` is set; per-process fallback logs a warning |
| Wallet challenges | Single-use, expiring challenges persisted in the `WalletNonce` table instead of process memory |
| Webhooks | SSRF guard at registration and delivery; signature and timestamp checks; retry, dead-letter (`FAILED`) and requeue covered by integration tests |
| Refund linkage | Approval records the decision without fabricating a transaction; once the indexer links the contract-assigned refund id, `POST /v1/refunds/:id/approve-transaction` returns the settlement-wallet approval transaction (`409 REFUND_NOT_LINKED` before the link exists) |
| k6 | `loadtest/wpay.k6.js` with read and login scenarios, thresholds and a seed script; wired into CI |
| Backups | `scripts/db-backup.sh` (optional GPG encryption), `scripts/db-restore-drill.sh` (decrypts `.gpg`, checks new tables, reports wall time), and `.github/workflows/backup.yml` (daily dump, manifest, restore verification, 30-day artifact) |
| Images and supply chain | Docker bases pinned by digest, image build copies pnpm app-level `node_modules`, cosign keyless signing plus provenance/SBOM, digest-pinned CI services |
| Dependencies | zod upgraded to 4; transitive overrides moved to `pnpm-workspace.yaml`; production audit clean |
| Documentation | README, ROADMAP, DEPLOYMENTS, SECURITY, THREAT_MODEL, AUDIT, TESTING, DEPLOYMENT, DISASTER_RECOVERY, INDEXER and the engineering report reconciled with code and recorded results |
| Frontend integration (2026-11-13) | All three Next apps use the shared refresh-aware session client, render a visible config error without `NEXT_PUBLIC_API_URL`, and never show payment success before backend verification; merchant onboarding, admin intent signing, webhooks, API keys and settlement batches are wired to the real API |
| Auth hardening (2026-11-13) | Refresh token moved to an `HttpOnly`, `Secure`, `/v1/auth`-scoped cookie with CSRF header on refresh/logout; opaque tokens hashed, rotated and family-revoked on reuse; SEP-53 single-use challenges; unlisted-origin rejection |
| Production config fail-closed | Production boot refuses placeholder JWT secret, non-HTTPS or placeholder public URLs, and missing `REDIS_URL`; cookie SameSite/domain and `trust proxy` are configurable |
| Webhook delivery atomic claim | Timestamp-conditional claim prevents two workers from delivering the same attempt |
| Merchant fee enforcement | Non-staff merchant creation must match the authenticated wallet and is locked to the 250 bps platform rate |
| Invoice memo binding | Invoice confirmation verifies the contract invocation memo against the invoice number |
| Production deployment assets | `docker-compose.prod.yml` (Postgres, Redis, one-shot migrations, API, indexer, Caddy TLS), `.env.production.example`, `infra/caddy/Caddyfile`, per-app `.env.example` and `vercel.json`; nothing was deployed |

## 2. Verification results

The rows below are the 2026-11-12/13 checkpoint. Current counts and the new
checks are in section 8.

| Check | Command | Result |
| --- | --- | --- |
| Contract tests | `pnpm contracts:test` | 140 passed, 0 failed (18 suites, including 2 resource benchmarks) |
| Contract build | `pnpm contracts:build` | 16/16 WASM artifacts; hashes match the deployed Testnet contracts |
| Testnet deployment | `node scripts/deploy-testnet.cjs` | 16 contracts; upload and create transactions `SUCCESS` |
| Testnet payment | `node scripts/e2e-testnet.cjs` | payment 1 `Settled`; balances and event verified |
| API confirmation | local API + Testnet | invoice `PAID`, payment `SETTLED`, `contractPaymentId=1`; bogus hash and mismatched amount rejected |
| Typecheck | `pnpm typecheck` | 22/22 tasks |
| Build | `pnpm build` | API, indexer, three Next apps, mobile and extension build |
| TypeScript tests | `pnpm test` | 209 passed, 2 skipped (api 145, indexer 27, sdk 13, shared 10, e2e 10, database 4) |
| API coverage | `pnpm --filter @wpay/api test:coverage` | 89.4% statements |
| Postgres integration | `pnpm --filter @wpay/api test` with `DATABASE_URL` | real Postgres suites pass, including rollback/cleanup |
| Lint | `pnpm lint` | 15/15 tasks, 0 errors, 0 warnings |
| Dependency audit | `pnpm audit --prod --audit-level=high` | no known production vulnerabilities |
| Secrets | Gitleaks | no leaks in tracked history |
| Backup drill | `scripts/db-restore-drill.sh` | source and restored row counts match; encrypted backup round-trip passed; local restore ~1s |
| Browser checkout | `pnpm test:browser` | 5 passed with mocked Freighter + mocked API |
| Docker | API image build + health smoke | `/v1/health` returns `database: "up"` as non-root |
| Kubernetes/Helm | kubeconform, `helm lint`, `helm template` | 10 manifests and 8 rendered resources valid |
| Monitoring | promtool, amtool | Prometheus and Alertmanager configs valid |
| Compose | `docker compose config` | valid with required secrets supplied |

Full tables and per-package counts are in [TESTING.md](TESTING.md) and the
verification section of the [README](../README.md).

## 3. Contract deployment record

All 16 contracts are deployed on Stellar Testnet under a throwaway
friendbot-funded deployer key, deployed 2026-11-12T20:08:25Z. Each contract id,
upload transaction, create transaction and SHA-256 WASM hash is listed in
[DEPLOYMENTS.md](../DEPLOYMENTS.md). The record was generated from
`deployments/testnet.json`; no identifier in it was hand-written.

This is Testnet only. There is no mainnet deployment, no real funds and no
multisig key ceremony.

## 4. Security findings

Fixed during gap closure:

- Webhook SSRF: DNS resolution plus private/reserved IPv4/IPv6 (including
  mapped/embedded forms), local hostnames and credentials blocked; redirects
  refused; enforced at registration and delivery.
- Rate limiting across replicas: Redis store when configured.
- Wallet challenge replay: database-backed single-use records.
- Refund execution: no on-chain submission until the indexed refund is linked.
- Payment confirmation: settled only on a verified network result, with
  settlement/amount checks.
- Indexer failures: durable dead letters, automatic retry, health/metrics and
  admin endpoints; no silent projection loss.
- Production CORS allowlist and a readiness probe that checks Postgres and
  Soroban RPC.
- Settlement batches: operator-driven, duplicate-safe, 20-entry cap after a
  50-entry execute exceeded the local Soroban budget.
- Merchant fee evasion and owner spoofing: self-service creation is owner-bound
  and the fee is platform-controlled; `PATCH` cannot change it.
- Refresh-token theft: rotation plus family revocation; replay returns `401`.
- Invoice payment verification: memo is bound to the invoice number. The
  historical Testnet confirmation used an `e2e-invoice` memo and no longer
  passes invoice-level verification; it remains valid settlement evidence.
- Frontend fail-closed configuration: no localhost fallback in production
  builds.

Open and documented in [AUDIT.md](AUDIT.md):

- Centralized admin key (fee cap, pause, upgrade proposals); the Testnet
  deployer must not be reused.
- No independent audit or formal verification of contracts holding funds.
- Access and CSRF tokens are memory-only; the rotating refresh token is an
  `HttpOnly`, `Secure` cookie with CSRF headers on refresh/logout. Cross-site
  refresh depends on browser third-party-cookie policy, so a first-party cookie
  domain is preferred. The extension
  requests only the configured API origin at lookup time. Production Next builds
  send CSP and standard security headers.
- Real Freighter extension interaction not covered by CI; the browser suite has
  nine Playwright tests (checkout, merchant dashboard, admin dashboard) using a
  mocked provider and mocked API.
- Container hardening not exercised beyond build and health smoke test.
- `cargo audit` reports RUSTSEC-2026-0387 in transitive `crypto-bigint` 0.5.5
  (via `soroban-env-host` 29.0.1). The patched 0.7.x line is incompatible with
  the current SDK; CI ignores it explicitly and it is re-checked on SDK bumps.

The internal review in `AUDIT.md` is **not** an external audit, and none has
occurred.

## 5. Infrastructure and CI/CD

- CI runs typecheck, tests, lint, contract tests/build, `cargo audit`, a
  Playwright checkout job, `pnpm audit`, and a k6 load-test job against a
  seeded API.
- Backup workflow dumps production data daily, records row counts, verifies the
  dump by restoring it, and runs the restore drill against a fresh database.
- Deploy workflow builds multi-arch images with provenance/SBOM, signs digests
  with cosign keyless OIDC, verifies signatures, then runs Helm from a protected
  environment.
- Docker Compose, Kubernetes manifests, Helm chart, Prometheus/Alertmanager and
  Argo CD manifests are present and validate locally.
- Remote `CI` and `Security` runs succeeded on commit `3b197b0` (2026-11-12):
  Soroban contracts, TypeScript workspace, Rust dependency audit, browser wallet
  flow, indexer/API container builds, k6 load test, CodeQL, Trivy and Gitleaks.
  Dependency review is PR-only and image signing runs only in the deploy
  workflow, which was not executed. Cluster apply and alert delivery were not
  exercised.
- The backend was not hosted at the time of this snapshot; it is now live on
  Vercel/Neon/Upstash (see the later-state note above), with webhook and
  indexer catch-up on two schedulers rather than resident workers.

## 6. Remaining blockers

1. Independent smart-contract audit before any mainnet use.
2. Multisig/hardware key ceremony and a timelock for admin powers.
3. Real-time worker host attached to the hosted database (the API, Postgres and
   Redis are hosted; the indexer/webhook catch-up runs on schedulers); PITR and
   scheduled off-site upload of encrypted backups.
4. Real-extension Playwright tests covering Freighter rejection/approval.
5. Live Testnet settlement execution and reconciliation proof. Automatic
   prepare/execute orchestration and reconciliation are implemented and tested
   against Postgres with a fake executor, but no batch has run on Testnet and
   migration 0008 is not applied to the hosted database.
6. Cluster deployment, alert delivery, image signing, and measured production
   RTO/RPO (only logical restore time is measured). Remote `CI` and `Security`
   are green.

Until items 1-3 are complete, W-Pay is a verified Testnet prototype, not a
production payment gateway.

## 7. Update — 2026-11-20 review pass

This pass changed code and documentation without changing contract sources,
contract ids or deployed WASM. Results below were produced locally in this
workspace; no CI run or deployment was performed for these uncommitted changes.

Fixed:

- Unscoped API keys could widen beyond their owner. Non-staff keys now require a
  `merchantId`; access checks require a scoped key to match the merchant.
- Cross-merchant IDOR in subscription listing, notifications list/mark-read and
  treasury overview. Query filters now compose with ownership instead of
  replacing it.
- Merchant settlement changes bypassed the contract for registry-linked
  merchants. `PATCH /merchants/:id` now rejects settlement changes for linked
  merchants; `POST /merchants/:id/settlement-intent` builds the on-chain update.
  Registry-linked status changes return intents and are no longer written
  optimistically; reactivation uses `merchant_registry.reactivate`.
- The SDK sent `{ query }` as the JSON body of `GET /v1/analytics/overview`,
  which browsers reject ("Request with GET/HEAD method cannot have body") and
  which broke dashboard analytics. The query now goes in the options argument,
  with a regression test.
- The mobile app silently pointed a non-local deployment at localhost. It now
  requires `VITE_API_URL` and renders a configuration error otherwise.
- Freighter signing did not check the wallet network. Checkout and the shared
  signer now refuse to sign when the wallet reports a different network.
- Indexer retries could regress terminal projections (refunds, invoices,
  escrows, subscriptions, settlements, merchant status). Projections are now
  guarded by source state and monotonic where cumulative.
- Health reported static contract flags and had no Redis/indexer visibility.
  `/v1/health` now probes Redis and reports checkpoint lag and unresolved
  failures; `/v1/health/ready` includes Redis but never gates on indexer lag.

Verified locally:

- `pnpm typecheck`: 23/23 tasks.
- `pnpm lint`: 15/15 tasks, 0 errors.
- `pnpm build`: 15/15 tasks.
- `pnpm test`: 239 passed, 2 skipped (api 167, indexer 30, sdk 14, hooks 4,
  shared 10, e2e 10, database 4) against Postgres.
- `pnpm test:browser`: 9 passed (checkout 5, merchant 2, admin 2), mocked
  Freighter and API.
- API coverage: 88.8% statements, 72.73% branches, 92.02% functions.
- `pnpm audit --prod --audit-level=high`: no known production vulnerabilities
  (unchanged from the previous run).

Still open or BLOCKED:

- WASM hash re-verification was not run in this environment (`cargo` is not
  installed); contract sources are unchanged, but rebuild-and-compare is left to
  CI.
- No independent audit, no mainnet, no real-extension hosted payment, no live
  batched settlement execution.
- New documentation: [SETTLEMENT.md](SETTLEMENT.md) and
  [TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md).

## 8. Update — 2026-11-22 gap-closing pass

This pass adds functionality and tests on top of the checkout above. It did not
change contract sources, contract ids or deployed WASM. All results below were
produced locally; no CI run, migration or deployment of the new code was
performed.

Implemented:

- **Automatic settlement and reconciliation.** `SETTLEMENT_AUTOMATION=off|
  prepare|execute`, hold period, capped batch size, atomic payment claims,
  refund-aware amounts, resumable on-chain execution, exponential backoff,
  in-app alerts, admin retry and a reconciliation report. Routes:
  `POST /v1/admin/settlements/run`, `GET .../automation`, `GET
  .../reconciliation`, `POST .../:id/retry`. Migration
  `0008_settlement_automation`.
- **Indexer replay and consistency.** `Indexer.resetCheckpoint`, bounded
  `Indexer.replay`, `Indexer.consistency`; admin replay endpoint (ADMIN,
  audit-logged) and consistency endpoint (OPERATOR). Replay is idempotent and
  bounded by `maxPages`; the report checks checkpoints, staleness, dead letters,
  unknown event kinds, settled payments without a contract link, paid invoices
  without a payment, and executed windows without a transaction.
- **Backups.** Conditional archive TOC validation (`pg_restore --list` when
  available; the workflow verify job has it, the local run did not), SHA-256
  sidecars, AES-256 passphrase or GPG public-key encryption, safe retention
  pruning, full public-table and applied-migration restore comparison, workflow
  preflight/metadata/checksum/decryption steps.
- **CI and security gates.** `cargo clippy -D warnings`, ignored Soroban
  resource benchmark, `prisma validate`, shell syntax, Compose validation,
  production dependency audit on push/schedule, and backup workflow timeouts.
- **Settlement executor tests.** Twelve parser/executor tests cover open,
  partial resume without duplicate entries, close/execute, transaction budget,
  terminal windows, token/payee/amount mismatches, cancellation, undecodable
  state and a failed submission classified as retryable.
- **Contributor readiness.** Bug/feature/contributor-task issue templates, pull
  request template, and a scoped backlog in
  [CONTRIBUTOR_ISSUES.md](CONTRIBUTOR_ISSUES.md). No remote issues were created.

Verified locally:

- `pnpm build`: 15/15 tasks.
- `pnpm typecheck`: 23/23 tasks.
- `pnpm lint`: 15/15 tasks, 0 errors, 0 warnings.
- `pnpm test` with Postgres: 263 passed, 2 skipped (api 190, indexer 31, sdk 14,
  hooks 4, shared 10, e2e 10 + 2 skipped, database 4).
- API coverage: 88.25% statements, 71.87% branches, 91.36% functions; the
  settlement executor is 90.42% statements, including resume, budget, mismatch,
  cancellation and failed-transaction paths. The live Soroban submission path
  still uses a fake gateway and is not Testnet-verified.
- `pnpm test:browser`: 9 passed after installing Chromium system dependencies.
- API and indexer Docker images build and boot; `/v1/health` and indexer
  `/health` return 200.
- Backup: encrypted AES-256 round-trip, checksum verification, every-table row
  counts and 8 applied migrations matched; retention pruning removed only WPay
  artifacts. Archive TOC validation is configured but was skipped locally
  because `pg_restore` is not installed; the backup workflow has not run.
- Rust on rustc 1.100.0: `cargo fmt --check`, `cargo clippy --all-targets -- -D
  warnings`, `cargo test` (140 passed, including both resource benchmarks) and
  the 16-contract WASM build all pass.
- Workflow YAML parses; `bash -n scripts/*.sh` passes.
- GitHub Actions on `575012f` (2026-11-22): CI run 45066533798 and Security run
  45066533736 both succeeded; all 11 check runs completed and none was skipped.
  Dependency review is PR-only and will run on the next pull request.

Not verified / BLOCKED:

- No Testnet settlement execution. The automatic suite uses a fake executor and
  does not prove live signing, RPC parsing or pool funding.
- The hosted Neon database still has 7 migrations, and the hosted API predates
  this code. Migration 0008 and a redeploy are required before using the routes.
- The GitHub `DATABASE_URL` secret is still absent, so scheduled production
  backups fail closed. A local drill is not a production backup.
- No external audit, multisig, hardware-wallet custody or real-extension
  browser payment.
