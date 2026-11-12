# W-Pay engineering report

Date: 2026-11-12
Scope: original W-Pay build extending the existing workspace (4 contracts and a
TS skeleton), rebranded and completed. No deployment was performed.

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
| `cargo test --manifest-path packages/contracts/Cargo.toml` | **138 tests, 18 suites, 0 failures** |
| `cargo fmt --all --manifest-path packages/contracts/Cargo.toml -- --check` | clean |
| `pnpm contracts:build` | **16/16 WASM artifacts** (20–41 KB) |
| `pnpm typecheck` | **22/22 tasks** pass |
| `pnpm test` | **52 passed, 2 skipped**, 22/22 tasks (shared 10, database 4, api 10, sdk 11, indexer 7, e2e 10; live-API tests skip without `WPAY_E2E_API_URL`) |
| `pnpm lint` | 15/15 tasks, 0 errors, 1 warning (`@wpay/hooks` unused declaration) |
| `pnpm build` | 15/15 tasks: api, indexer, web, merchant, admin, mobile, extension |
| `prisma validate` / `generate` | pass |

Not run: Docker image builds, Helm template/lint, Kubernetes apply, live-network
tests, browser interaction tests, load tests.

## 3. Features

Complete: contract suite and cross-contract tests; API surface listed in
`docs/API.md`; API-key and JWT auth plus SEP-53 wallet challenge; idempotent
payment intents and confirmation; invoices and public checkout; escrow/refund/
subscription flows; HMAC webhooks with retries; indexer projection; three web
apps with real API calls; mobile PWA invoice lookup; extension lookup/copy;
SDK; Docker/Helm/K8s/monitoring/CI scaffolding.

Partial: refund approval is recorded but on-chain execution waits for the
indexed contract refund id; mobile/extension are read-only; rate limiting and
challenge storage are process-local; monitoring assumes metrics names emitted
by the API/indexer (dashboards not validated against a live scrape).

## 4. Security findings

Fixed during the build: contract event topic length (`unpauseall` → `unpause`);
nested-auth refund tests now authorize with the settlement address (previously
masked by `mock_all_auths`); `config.contractEnvVar` generated
`CONTRACTPAYMENT_ROUTER_ID`, so no contract id could ever be loaded — corrected
to `CONTRACT_*_ID` and covered by an e2e test that cross-checks `.env.example`.

Open, documented in `docs/AUDIT.md`: webhook SSRF (high), centralized admin keys
(high), unaudited contracts handling funds (high), per-replica rate limiting,
process-local challenge store, JWT in `localStorage`, broad extension host
permissions, untested read-only-root container hardening.

No secret scanning or Trivy result was produced locally; those checks are
configured in `security.yml` and have not run on this checkout.

## 5. Deployment status

**Only the three frontends are deployed** (Vercel team `w-pay`): checkout
<https://wpay-web.vercel.app>, merchant <https://wpay-merchant.vercel.app>,
admin <https://wpay-admin.vercel.app> — each verified HTTP 200 on 2026-11-12.
They are static hosting and cannot process payments because no API, Postgres,
indexer or contract is deployed; invoice lookup and logins in the live pages
therefore fail.
`DEPLOYMENTS.md` records this precisely, including that the API responds with
"not configured" when contract ids are unset rather than simulating success.

## 6. Remaining gaps

1. Independent audit and testnet deployment with verified ids.
2. Refund id linkage and indexer-driven settlement reconciliation.
3. Shared rate limiting/challenge storage; webhook SSRF defence.
4. Postgres-backed integration tests and browser E2E.
5. Load, backup-restore and incident drills.
6. CI has never executed on this repository (no remote run); the workflow files
   are unvalidated by a real CI run.
