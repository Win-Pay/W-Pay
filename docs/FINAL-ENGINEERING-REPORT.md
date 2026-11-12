# Final engineering report

Date: 2026-11-12
Repository: `/workspaces/W-Pay`
Scope: gap closure against the engineering brief, run on the existing W-Pay
monorepo without rebuilding or replacing working modules.

This report is an acceptance record, not an audit opinion and not evidence of a
mainnet launch. Every result below was produced by a command or query in this
workspace; deployment identifiers live in [DEPLOYMENTS.md](../DEPLOYMENTS.md).

## 1. What changed

| Area | Change |
| --- | --- |
| Testnet deployment | Deployed the four contracts missing from the earlier 12 and verified all 16 ids, upload/create transactions and WASM hashes; replaced the draft deployment table with records generated from `deployments/testnet.json` |
| On-chain confirmation | API confirmation requires a `SUCCESS` result for the expected contract call and amount; bogus hashes and mismatched amounts leave the invoice `OPEN` |
| Indexer | Event ingestion, checkpoints, payment/refund/escrow/settlement projections documented in [INDEXER.md](INDEXER.md); idempotent upserts; durable `IndexerFailure` dead letters with automatic retry and admin visibility; transaction hash and contract ids persisted |
| Postgres integration tests | Real Postgres suites for auth, merchants, invoices, payments, webhooks and on-chain write paths, using transactions and cleanup |
| Coverage | API coverage **89.45% statements**, with money paths at 90% (payments), 91.48% (invoices), 91.27% (operations), 92.93% (platform settlements), 94.57% (auth) |
| Rate limiting | Redis-backed store used when `REDIS_URL` is set; per-process fallback logs a warning |
| Wallet challenges | Single-use, expiring challenges persisted in the `WalletNonce` table instead of process memory |
| Webhooks | SSRF guard at registration and delivery; signature and timestamp checks; retry, dead-letter (`FAILED`) and requeue covered by integration tests |
| Refund linkage | Approval builds the contract call only after the indexer links the contract-assigned refund id; otherwise `409` |
| k6 | `loadtest/wpay.k6.js` with read and login scenarios, thresholds and a seed script; wired into CI |
| Backups | `scripts/db-backup.sh` (optional GPG encryption), `scripts/db-restore-drill.sh` (decrypts `.gpg`, checks new tables, reports wall time), and `.github/workflows/backup.yml` (daily dump, manifest, restore verification, 30-day artifact) |
| Images and supply chain | Docker bases pinned by digest, image build copies pnpm app-level `node_modules`, cosign keyless signing plus provenance/SBOM, digest-pinned CI services |
| Dependencies | zod upgraded to 4; transitive overrides moved to `pnpm-workspace.yaml`; production audit clean |
| Documentation | README, ROADMAP, DEPLOYMENTS, SECURITY, THREAT_MODEL, AUDIT, TESTING, DEPLOYMENT, DISASTER_RECOVERY, INDEXER and the engineering report reconciled with code and recorded results |

## 2. Verification results

| Check | Command | Result |
| --- | --- | --- |
| Contract tests | `pnpm contracts:test` | 140 passed, 0 failed (18 suites, including 2 resource benchmarks) |
| Contract build | `pnpm contracts:build` | 16/16 WASM artifacts; hashes match the deployed Testnet contracts |
| Testnet deployment | `node scripts/deploy-testnet.cjs` | 16 contracts; upload and create transactions `SUCCESS` |
| Testnet payment | `node scripts/e2e-testnet.cjs` | payment 1 `Settled`; balances and event verified |
| API confirmation | local API + Testnet | invoice `PAID`, payment `SETTLED`, `contractPaymentId=1`; bogus hash and mismatched amount rejected |
| Typecheck | `pnpm typecheck` | 22/22 tasks |
| Build | `pnpm build` | API, indexer, three Next apps, mobile and extension build |
| TypeScript tests | `pnpm test` | 194 passed, 2 skipped |
| API coverage | `pnpm --filter @wpay/api test:coverage` | 89.45% statements |
| Postgres integration | `pnpm --filter @wpay/api test` with `DATABASE_URL` | real Postgres suites pass, including rollback/cleanup |
| Lint | `pnpm lint` | 15/15 tasks, 0 errors, 0 warnings |
| Dependency audit | `pnpm audit --prod --audit-level=high` | no known production vulnerabilities |
| Secrets | Gitleaks | no leaks in tracked history |
| Backup drill | `scripts/db-restore-drill.sh` | source and restored row counts match; encrypted backup round-trip passed; local restore ~1s |
| Browser checkout | `pnpm test:browser` | 3 passed with mocked Freighter + mocked API |
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

Open and documented in [AUDIT.md](AUDIT.md):

- Centralized admin key (fee cap, pause, upgrade proposals); the Testnet
  deployer must not be reused.
- No independent audit or formal verification of contracts holding funds.
- JWT stored in `localStorage`; broad extension host permission.
- Real Freighter extension interaction not covered by CI; three Playwright
  checkout tests use a mocked provider and mocked API.
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
- The backend is not hosted; the Vercel frontends are static only and cannot
  process payments until an API and database are deployed.

## 6. Remaining blockers

1. Independent smart-contract audit before any mainnet use.
2. Multisig/hardware key ceremony and a timelock for admin powers.
3. Hosted API, Postgres, Redis and indexer (with PITR and scheduled off-site
   upload of encrypted backups); point the dashboards at them.
4. Real-extension Playwright tests covering Freighter rejection/approval.
5. Automatic settlement worker and a full reconciliation report (operator
   batch API exists).
6. Cluster deployment, alert delivery, image signing, and measured production
   RTO/RPO (only logical restore time is measured). Remote `CI` and `Security`
   are green.

Until items 1-3 are complete, W-Pay is a verified Testnet prototype, not a
production payment gateway.
