# Implementation audit

Date: 2026-11-12
Purpose: map each requirement of the gap-closure brief to where it is
implemented and how it was verified. This is an internal engineering audit, not
an independent security audit. Security limitations are recorded in
[AUDIT.md](AUDIT.md); deployment identifiers in
[DEPLOYMENTS.md](../DEPLOYMENTS.md).

Status keys: **done** = implemented and exercised; **partial** = implemented but
not fully exercised; **open** = not implemented.

## Contracts and deployment

| Requirement | Status | Evidence |
| --- | --- | --- |
| Compile all 16 Soroban contracts | done | `pnpm contracts:test` 140/140 (138 behaviour + 2 resource benchmarks); `pnpm contracts:build` produces 16 artifacts |
| Verify the 12 previously claimed addresses | done | [DEPLOYMENTS.md](../DEPLOYMENTS.md) records all 16 ids, upload/create transactions and WASM hashes generated from `deployments/testnet.json` |
| Deploy the four missing contracts | done | `scripts/deploy-testnet.cjs` is idempotent and deployed 16/16 on Testnet; missing ids are included in the table |
| Verify WASM hashes | done | SHA-256 in `DEPLOYMENTS.md` matches the built artifacts for 16/16 |
| No invented deployment records | done | Table mechanically generated from the deployment JSON; the earlier hand-written draft was removed |

## Blockchain integration

| Requirement | Status | Evidence |
| --- | --- | --- |
| Indexer read models | done | `apps/indexer/src/indexer.ts`, `decode.ts`; projections documented in [INDEXER.md](INDEXER.md) |
| Persist transaction/event ids | done | payment, refund, escrow and settlement projections write tx hash and contract ids |
| Confirmation and reconciliation | done | `apps/api/src/soroban.service.ts` checks the network result; Testnet payment confirmed into Postgres and negative cases rejected |
| Escrow/refund/settlement sync | done | indexer projections plus refund-linkage rule in the API (no submission before the indexed refund id) |
| Never mark success without network confirmation | done | `SETTLED`/`PAID` transitions require a verified `SUCCESS` result; `blockchain.integration.test.ts` covers rejection |
| Replay/retry/idempotency | done | per-payment idempotency keys, event upserts keyed by event id, checkpoint replay |

## Backend and database

| Requirement | Status | Evidence |
| --- | --- | --- |
| Postgres integration tests with transactions/rollbacks | done | `apps/api/src/postgres.integration.test.ts`, `blockchain.integration.test.ts`, `webhooks/webhooks.integration.test.ts` |
| Payment/refund idempotency | done | idempotency handling in `apps/api/src/modules/payments.ts` and refund approval path |
| API line coverage ≥80%, money paths ≥90% | done | 89.4% statements; payments 90.03%, invoices 91.95%, operations 91.49%, platform 91.97%, auth 90.76% |
| Distributed rate limiting | done | `RedisRateLimitStore` in `apps/api/src/rate-limit.store.ts`; production refuses to boot without `REDIS_URL` unless `ALLOW_IN_MEMORY_RATE_LIMIT=1` is set |
| Webhook signature/retry/DLQ tests | done | signature and timestamp checks; atomic timestamp-conditional claim; retry then `FAILED` dead-letter and requeue in `webhooks.integration.test.ts` |
| Session delivery and CSRF | done | refresh token is an `HttpOnly`, `Secure`, `/v1/auth`-scoped cookie, rotated and family-revoked; refresh/logout require `x-csrf-token`; unlisted-origin state changes return `403 ORIGIN_FORBIDDEN`; verified in Postgres integration and a production Docker smoke test |
| Fail-closed production config | done | `assertProductionConfig` rejects placeholder secrets/URLs and missing Redis; `trust proxy` defaults to one hop; tested in `apps/api/src/config.test.ts` |
| Health, readiness and dependency failures | done | `/health/ready` probes Postgres and Soroban RPC (`getLatestLedger`), returning 503; storage/Redis failures propagate |
| Production CORS/auth configuration | done | `WEB_PUBLIC_URL` + `CORS_ORIGINS` allowlist; localhost only outside production |
| Settlement batch processing | done/partial | operator batch API, duplicate/period checks, link/intents/execute/cancel, SDK builders and Postgres tests; automatic worker and funding automation remain open |
| Indexer dead-letter/retry/recovery | done | `IndexerFailure`, retry on every tick, resolved-on-success, health/metrics/admin endpoints; recovery tests |

## Frontend and wallet

| Requirement | Status | Evidence |
| --- | --- | --- |
| Checkout submits real Soroban transactions | done | `apps/web` builds and submits signed XDR through the API; the API verifies the result |
| Invoice/payment/merchant/admin/pause flows | done | API and dashboards implement these; admin pause builds the intent transaction |
| Loading/error/confirmation states, no simulated success | done | no settled state without an API/on-chain result; refund approval returns `409` while unlinked |
| Browser wallet interaction tested | **partial** | Freighter connect/sign/submit implemented; 5 Playwright tests use a mocked provider and mocked API (checkout, fee disclosure, receipt/Explorer, failure, landing). Real-extension signing is not tested |

## Security

| Requirement | Status | Evidence |
| --- | --- | --- |
| Threat model and authorization review | done | [THREAT_MODEL.md](THREAT_MODEL.md), [AUDIT.md](AUDIT.md) |
| Treasury/escrow/refund accounting | done | checked arithmetic and caps in contracts; reconciliation guidance in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| Upgrade mechanism review | done | upgrade manager requires proposal, delay and authority; delay configuration remains an operational task |
| Regression tests for findings | done | SSRF, rate limit, challenge, refund linkage, confirmation, settlement batch, indexer retry, cookie/CSRF and origin-rejection tests |
| Key management design | done/partial | [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md) documents 2-of-3 multisig, HSM and timelock ceremony; not executed, no Mainnet authority exists |
| Soroban resource benchmarks | done | two `WPAY_BENCH` tests plus `pnpm measure:testnet` (RPC simulation and recorded transaction fees/sizes) |
| Enforceable dependency checks | done | `pnpm audit --prod --audit-level=high` in CI; lockfile; transitive overrides |
| Pin Docker digests and package-manager versions | done | base images and CI services pinned by digest; `packageManager` pinned in `package.json` |
| Gitleaks/CodeQL/Trivy/image signing | done/partial | Gitleaks CLI (pinned 8.30.1) runs clean locally and in CI; CodeQL, Trivy and dependency review are configured in `security.yml`; cosign signing is in `deploy.yml`. `CI` and `Security` succeeded on commit `3b197b0` (2026-11-12). Dependency review is PR-only and image signing was not exercised |
| Prepare contracts for independent audit | **partial** | tests, docs and recorded deployment exist; no independent audit has occurred |
| Never claim an external audit | done | README, SECURITY, AUDIT and the final report state that none occurred |

## Infrastructure

| Requirement | Status | Evidence |
| --- | --- | --- |
| k6 wired into CI | done | `loadtest/wpay.k6.js` and the `loadtest` job in `.github/workflows/ci.yml` |
| PostgreSQL backup workflow and restore drill | done | `.github/workflows/backup.yml`, `scripts/db-backup.sh`, `scripts/db-restore-drill.sh`; drill executed with matching counts; optional GPG encryption and encrypted restore verified locally; local restore ~1s |
| Docker Compose verified | done | `docker compose config` validates; API image builds and passes health smoke |
| Kubernetes/Helm/Prometheus/Grafana/GitOps validated | done/partial | kubeconform, Helm lint/template, promtool and amtool passed in this checkout; no cluster apply, live scrape or Argo sync observed. Compose and Helm re-checked 2026-11-12; kubeconform/promtool/amtool were not installed at the final re-check |

## Documentation reconciliation

| Document | State |
| --- | --- |
| `README.md` | Current status, implemented/not implemented, verification table |
| `ROADMAP.md` | Completed gap-closure items marked; remaining work listed |
| `DEPLOYMENTS.md` | Verified 16-contract Testnet record, E2E payment, frontend records |
| `SECURITY.md` | Scope, model, fixed issues, accepted risks |
| `docs/AUDIT.md` | Internal review with findings and fixed/open status |
| `docs/THREAT_MODEL.md` | Threat table updated for SSRF, Redis, DB-backed challenges |
| `docs/INDEXER.md` | Ingestion, projections, replay and limitations |
| `docs/TESTING.md` | Commands and actual counts |
| `docs/DEPLOYMENT.md` | Testnet automation, production steps, backup |
| `docs/DISASTER_RECOVERY.md` | Automated backups, encryption, measured local restore and remaining DR gaps |
| `docs/KEY_MANAGEMENT.md` | Multisig/HSM/timelock design and ceremony checklist |
| `docs/ENGINEERING_REPORT.md` | Build history and verified results |
| `docs/FINAL-ENGINEERING-REPORT.md` | Acceptance record and blockers |

## Open items

1. Independent contract audit and multisig/timelock key ceremony.
2. Hosted backend with PITR and scheduled off-site upload of encrypted backups.
3. Real-extension Playwright tests; current browser tests mock Freighter.
4. Settlement batch worker and reconciliation report.
5. Cluster deployment, alert delivery, image signing, and measured production RTO/RPO (only logical restore time is measured). Remote `CI` and `Security` are green.
6. Mainnet deployment. None has occurred.
