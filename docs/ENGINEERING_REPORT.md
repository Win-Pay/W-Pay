# W-Pay engineering report

Date: 2026-11-12
Scope: original W-Pay build extending the existing workspace (4 contracts and a
TS skeleton), rebranded and completed, followed by gap closure. All 16 contracts
were deployed to Stellar Testnet and an end-to-end Testnet payment was verified.
No mainnet deployment and no external audit occurred.

## 1. Deliverables

### Contracts (`packages/contracts`)
Created: `payment-router`, `invoice-manager`, `escrow-manager`, `refund-manager`,
`subscription-manager`, `settlement-manager`, `treasury-vault`,
`emergency-pause`, `upgrade-manager`, `price-oracle`, `governance`,
`impact-nft` (each `src/lib.rs`, `src/test.rs`, `Cargo.toml`); extended
`wpay-common` with shared types, access/pause/validation/token modules and
cross-contract client traits; extended `merchant-registry` with
`set_pause_authority`; added `integration-tests` lifecycle suite; added
`scripts/build-contracts.sh`.

### Packages
`types` (zod + DTOs), `config` (networks, env mapping, fee math, stroop
conversion), `shared` (errors, cursors, webhook HMAC, wallet message),
`database` (Prisma schema, baseline migration, client, seed, helpers), `sdk`
(HTTP client, API resources, Soroban gateway, builders, wallet adapters), `ui`
(design system + components), `hooks`.

### Apps
`api` (NestJS: auth, merchants, payments, invoices, escrows, refunds,
subscriptions, settlements, treasury, api-keys, notifications, admin, webhooks,
analytics, health/metrics, transaction submission), `indexer` (event decoding,
idempotent projection, checkpoints, health/metrics), `web` (public checkout),
`merchant-dashboard`, `admin-dashboard`, `mobile` (PWA), `extension` (MV3).

### Operations and docs
`infra/docker/*`, `docker-compose.yml`, `k8s/*`, `helm/wpay/*`, `monitoring/*`,
`gitops/*`, `.github/workflows/{ci,security,deploy}.yml`, `.gitleaks.toml`,
`.env.example`, `LICENSE`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `ROADMAP.md`, `DEPLOYMENTS.md`,
`THIRD_PARTY_NOTICES.md`, and `docs/{ARCHITECTURE,API,CONTRACTS,INSTALL,
ENVIRONMENT,TESTING,DEPLOYMENT,DISASTER_RECOVERY,THREAT_MODEL,AUDIT}.md`,
`tests/e2e`.

## 2. Verified results (commands actually run)

| Command | Result |
| --- | --- |
| `cargo test --manifest-path packages/contracts/Cargo.toml` | **140 tests, 18 suites, 0 failures** (138 behaviour + 2 benchmarks) |
| `cargo fmt --all --manifest-path packages/contracts/Cargo.toml -- --check` | clean |
| `pnpm contracts:build` | **16/16 WASM artifacts** (20–41 KB) |
| `pnpm typecheck` | **22/22 tasks** pass |
| `pnpm test` | **199 passed, 2 skipped** (api 136, indexer 27, sdk 12, shared 10, e2e 10, database 4) |
| `pnpm lint` | 15/15 tasks, 0 errors, 0 warnings after removing an unused declaration |
| `pnpm build` | 15/15 tasks: api, indexer, web, merchant, admin, mobile, extension |
| `prisma validate` / `generate` | pass |
| API coverage | 89.4% statements; payments 90.03%, invoices 91.95%, operations 91.49%, platform 91.97%, auth 90.76% |
| `node scripts/deploy-testnet.cjs` | 16/16 contracts deployed; upload/create txs `SUCCESS`; WASM hashes 16/16 |
| `node scripts/e2e-testnet.cjs` | payment 1 `Settled`; balances and event verified |
| API confirmation against Testnet | invoice PAID, payment SETTLED, contractPaymentId 1; bogus/mismatched hashes rejected |
| `pnpm audit --prod --audit-level=high` | no known production vulnerabilities |
| Gitleaks | no leaks in tracked history |
| Docker API image | built; container `/v1/health` returns `database: "up"` and `/v1/health/ready` returns 200 |
| `pnpm test:browser` | 3 Playwright checkout tests pass (mocked wallet/API) |
| `pnpm measure:testnet` | recorded fee 82,589 stroops; simulated create 2,419,372 CPU, 83,770 min resource fee, 1,840-byte assembled envelope |
| Helm / kubeconform / Prometheus / Alertmanager | lint, template and schema/config checks pass |
| `scripts/db-restore-drill.sh` | restored row counts match source for core and new tables; encrypted round-trip passed; local restore ~1s |

Not run: Kubernetes apply against a live cluster, real-extension browser tests with
Freighter, chaos/incident timing drills, and any mainnet activity.

## 3. Features

Complete: contract suite and cross-contract tests; API surface listed in
`docs/API.md`; API-key and JWT auth plus SEP-53 wallet challenge; idempotent
payment intents and confirmation; invoices and public checkout; escrow/refund/
subscription flows; HMAC webhooks with retries; indexer projection; three web
apps with real API calls; mobile PWA invoice lookup; extension lookup/copy;
SDK; Docker/Helm/K8s/monitoring/CI scaffolding.

Fixed during gap closure: refund approval builds the contract call once the
indexer links the contract refund id; Redis rate limiting with an explicit
in-memory fallback; DB-backed single-use wallet challenges; webhook SSRF guard;
DB-backed API integration tests; Testnet deployment and E2E payment; k6 load
test; automated backup plus restore drill.

Fixed during the final integration pass: merchant self-service could previously
choose `feeBps` and spoof `ownerAddress` for another wallet (now owner-bound and
fee-locked to the platform rate); refresh tokens rotate with family-wide
revocation on reuse; invoice confirmation binds the invocation memo to the
invoice number; SEP-53 challenges are single-use; all three Vercel apps fail
closed with a visible config error instead of calling localhost; production
Compose/Caddy deployment assets and `NEXT_PUBLIC_API_URL` build configuration
were added.

Partial: mobile/extension are read-only; the hosted frontends still have no
hosted API; monitoring configs validate but dashboards were not checked against
a live scrape; browser checkout is covered by Playwright with a mocked provider only.

## 4. Security findings

Fixed during the build: contract event topic length (`unpauseall` → `unpause`);
nested-auth refund tests now authorize with the settlement address (previously
masked by `mock_all_auths`); `config.contractEnvVar` generated
`CONTRACTPAYMENT_ROUTER_ID`, so no contract id could ever be loaded — corrected
to `CONTRACT_*_ID` and covered by an e2e test that cross-checks `.env.example`.

Fixed during gap closure: webhook SSRF (DNS + private/reserved address blocking
at registration and delivery), per-replica rate limiting (Redis store), and the
challenge store (previously process-local; now persisted in the `WalletNonce`
table and verifiable from any replica).

Open, documented in `docs/AUDIT.md`: centralized admin keys (the Testnet
deployer is a throwaway single key), unaudited contracts handling funds, JWT in
`localStorage`, broad extension host permissions, and container hardening not
exercised beyond a build/health smoke test.

Locally executed: Gitleaks (no leaks) and `pnpm audit --prod --audit-level=high`
(no known production advisories after zod 4 and transitive overrides). Trivy,
CodeQL and dependency review are configured in `security.yml`. Remote `CI` and
`Security` runs succeeded on commit `3b197b0` (2026-11-12), covering contract
tests/build, typecheck/lint/tests, Rust audit, browser wallet flow, container
builds, k6, CodeQL, Trivy and Gitleaks. Dependency review is PR-only and image
signing runs only in the deploy workflow, which was not executed. Docker builds
add provenance/SBOM and the deploy workflow signs images with cosign keyless
OIDC and verifies signatures.

## 5. Deployment status

**Contracts: Testnet.** All 16 contracts are deployed (ids, upload/create txs
and WASM hashes in `DEPLOYMENTS.md`), and payment 1 settled through
`PaymentRouter` with exact fee/net balances and event contents verified. The
API confirmed the transaction into Postgres (`SETTLED`, `contractPaymentId=1`)
and rejected a bogus hash and a mismatched amount.

**Backend: not hosted.** API, Postgres and indexer run locally/compose only.
The API container builds and passes a health smoke test. The three Vercel
frontends (checkout <https://wpay-web.vercel.app>, merchant
<https://wpay-merchant.vercel.app>, admin <https://wpay-admin.vercel.app>) are
static hosting and cannot process payments until the backend is hosted.

`DEPLOYMENTS.md` records the deployment precisely. No mainnet deployment and no
external audit exists.

## 6. Remaining gaps

1. Independent audit before mainnet; multisig/timelock key ceremony.
2. Hosted API/indexer/Postgres and pointing the Vercel dashboards at them.
3. Playwright browser E2E against the real Freighter extension (mocked checkout flow exists).
4. PITR and scheduled off-site upload (logical dump, optional encryption and restore drill are automated).
5. Settlement batch worker and full reconciliation report.
6. Remote CI is green, but cluster deployment, alert delivery, image signing
   and production RTO/RPO remain unexercised.
