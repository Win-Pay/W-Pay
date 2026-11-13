# W-Pay

W-Pay is a Stellar/Soroban-native payment gateway: merchants accept payments,
issue invoices and payment links, hold funds in escrow, process refunds and
subscriptions, and settle to their own treasury address — with customer,
merchant and administrator applications, an on-chain event indexer, and a
TypeScript SDK.

> **Deployment status (2026-11-13): backend and frontends hosted, contracts
> live on Testnet.** The API runs on Vercel at
> https://wpay-api-six.vercel.app on Neon Postgres and Upstash Redis, with all
> seven migrations applied and all 16 Testnet contract ids configured.
> `/v1/health` reports `database: "up"`, `soroban: "up"` and every contract;
> `/v1/health/ready` returns `ready: true`; the three frontends are deployed
> against that origin and browser-to-API calls were verified from each one.
> Two long-running processes are **not** hosted: the webhook delivery worker
> (`WEBHOOK_WORKER=off`) and the contract-event indexer. Both need a worker
> process (Compose or Kubernetes) against the same database. There is no
> mainnet deployment and no external audit. See
> [DEPLOYMENTS.md](DEPLOYMENTS.md) for verified contract ids and transaction
> hashes, [docs/VERCEL.md](docs/VERCEL.md) for hosting details and
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the worker runbook.

## Live deployments

| Component | URL | Host |
| --- | --- | --- |
| REST API | https://wpay-api-six.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-api) |
| Customer checkout | https://wpay-web.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-web) |
| Merchant dashboard | https://wpay-merchant.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-merchant) |
| Admin dashboard | https://wpay-admin.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-admin) |

Verified against the hosted stack on 2026-11-13:

- `GET /v1/health` and `/v1/health/ready` return `200` with Postgres and
  Soroban RPC up; all 16 contract flags are true.
- A login attempt for an unknown account returns `401` after a real Neon query
  (no fallback storage).
- `/v1/auth/csrf` sets a `Secure; HttpOnly; SameSite=None` cookie.
- Each frontend origin is echoed in `Access-Control-Allow-Origin`; a mutation
  from an unlisted origin returns `403 ORIGIN_FORBIDDEN`.
- Headless Chromium loaded all three frontends and successfully called the API
  from the page (`/v1/health` 200, `/v1/auth/csrf` 200, refresh `401` without
  a session).
- All 16 contract instances still exist on Testnet (read-only RPC check).

The `wpay-web` project also has `winpay.com` attached, but Vercel reports the
domain as misconfigured: DNS still resolves to an unrelated Cloudflare/PHP site.
The exact records to move it are in [docs/VERCEL.md](docs/VERCEL.md); use the
`*.vercel.app` URLs until then.

### How the backend is hosted

The repository root has a `vercel.json` that rewrites every path to one
serverless function. `api/index.js` is generated at build time (git-ignored) by
`scripts/build-serverless.mjs`: esbuild bundles the Nest entrypoint and SWC
emits decorator metadata, because Vercel's Node launcher cannot `require()`
ESM-only packages that `@stellar/stellar-sdk` depends on. `@prisma/client` stays
external so the generated client and its `rhel-openssl-3.0.x` engine are traced
into the function. Build order: workspace builds → root `prisma generate` →
bundle → static `public/`.

Environment on the Vercel project: `DATABASE_URL`/`DATABASE_URL_UNPOOLED`
(Neon), `REDIS_URL` plus the Upstash `KV_*` values, `JWT_SECRET`,
`API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `CORS_ORIGINS`, `STELLAR_NETWORK=testnet`,
`TRUST_PROXY=1`, `REFRESH_COOKIE_SAMESITE=none`, `WEBHOOK_WORKER=off`, and the
16 `CONTRACT_*_ID` values. The frontends need only the build-time
`NEXT_PUBLIC_API_URL`.

| Resource | Value |
| --- | --- |
| Neon project | `neon-citrine-compass` (free tier, `iad1`) |
| Upstash database | `upstash-kv-indigo-marble` (free tier) |
| Function region | `iad1`, Node.js 26 runtime, 30 s max duration |
| Migrations | 7 applied with `prisma migrate deploy` against the unpooled URL |

Serverless functions are request-scoped, and the `w-pay` team is on Vercel
Hobby (daily-only cron), so a cron cannot replace the 5-second webhook loop or
the indexer. Those workers are not running in the hosted environment; webhook
deliveries stay `PENDING` and indexed reads lag the chain until a worker host is
attached. Health still reports `database: "up"` because it checks the
connection, not worker liveness.

### Redeploying the hosted stack

Authenticate the CLI with a team-scoped token in `VERCEL_TOKEN`, then:

```bash
# API: rebuild the bundle and promote the prebuilt output
npx vercel build --prod --yes
npx vercel deploy --prebuilt --prod --yes

# Frontends: NEXT_PUBLIC_API_URL must be set on each project first
VERCEL_ORG_ID=team_1J3KJ7Vqb8fO1IZVH7NlosLS \
VERCEL_PROJECT_ID=prj_ePrybo8ylQ4nEvFpv9ka2paEpZ90 \
  npx vercel deploy --prod --yes   # wpay-web
```

| Project | Project id |
| --- | --- |
| `wpay-api` | `prj_EaaBNYt6rLVeL4BcgPzF07wktN3l` |
| `wpay-web` | `prj_ePrybo8ylQ4nEvFpv9ka2paEpZ90` |
| `wpay-merchant` | `prj_d1hQJC5YkOUWCxzGgfrDzo2bKX4E` |
| `wpay-admin` | `prj_v3O7BqaSJQybVv82udQBtDVVX70J` |

The frontends are separate projects with root directories under `apps/`, so
deploy them from the repository root with `VERCEL_PROJECT_ID` set (the API link
lives in the root `.vercel/project.json`). Contracts are independent of Vercel:
redeploying them needs `SOROBAN_SOURCE_SECRET` and
`node scripts/deploy-testnet.cjs`, which resumes from
`deployments/testnet.json` and skips contracts already recorded there.

## What is implemented

| Area | State |
| --- | --- |
| 16 Soroban contracts | Implemented in Rust, 140 tests (138 behaviour + 2 resource benchmarks), builds to `wasm32v1-none`; **all 16 deployed to Testnet** |
| REST API (NestJS) | Implemented and hosted on Vercel: auth with HttpOnly refresh cookies, CSRF headers and rotating tokens, merchants, payments, invoices, escrows, refunds, subscriptions, settlements, treasury, webhooks, analytics, audit, health, metrics; 145 tests including real Postgres integration |
| Database (Postgres + Prisma) | Schema, 7 migrations (including refresh-token families and indexer cursor), client, seed; transactions and rollbacks covered by integration tests; hosted on Neon with migrations applied |
| Indexer | Soroban RPC event ingestion with durable cursors, idempotent persistence, checkpoints, dead-letter retry with admin visibility, health/metrics, payment/refund/escrow/settlement projections — implemented, but **not hosted** on Vercel |
| TypeScript SDK | API client with automatic refresh retry, Soroban gateway, contract call builders, wallet adapters, tests |
| Customer checkout | Invoice lookup, merchant branding, transparent fee split, wallet connect/disconnect, signed Soroban payment, progress and receipt with Explorer link; success only after backend verification. A separate `/landing` page presents the product |
| Merchant dashboard | Email or wallet login, wallet onboarding, analytics, payments, invoices, refunds, settlement batches, subscriptions, webhooks and API keys |
| Admin dashboard | Email or wallet login, health, merchant approval/suspension, emergency pause intents, audit log, indexer failures, treasury withdrawals, settlement batches |
| Mobile PWA | Read-only invoice lookup and payment-link sharing |
| Browser extension (MV3) | Invoice lookup popup and checkout-link copying; host access is requested per configured API origin (`optional_host_permissions`) |
| Infrastructure | Hosted on Vercel (API + 3 frontends) with Neon and Upstash; Docker images, development and production Compose, Caddy HTTPS, Kubernetes manifests, Helm chart, Prometheus/Alertmanager/Grafana, Argo CD, CI + security workflows |

## What is not implemented / not verified

See [ROADMAP.md](ROADMAP.md), [docs/AUDIT.md](docs/AUDIT.md) and the
[final engineering report](docs/FINAL-ENGINEERING-REPORT.md). Short version:

- **Testnet only.** No mainnet deployment, no real funds, no external audit.
  The Testnet deployer is a throwaway friendbot-funded key, not multisig.
- The API and database are hosted on Vercel/Neon, but the **webhook delivery
  worker and indexer are not hosted**. Webhook deliveries stay `PENDING` and
  indexed reads lag the chain until a long-running worker (Compose or
  Kubernetes) is attached to the same database; refund approval also returns
  `409` until the indexer has linked the contract-assigned refund id. Vercel
  Hobby crons run at most daily, so they are not a substitute.
- `winpay.com` is attached to `wpay-web` in Vercel but its DNS is misconfigured
  and currently serves an unrelated Cloudflare/PHP site; use the
  `*.vercel.app` URLs until the records in
  [docs/VERCEL.md](docs/VERCEL.md) are applied.
- No hosted end-to-end payment with a real Freighter extension has been
  exercised yet. The hosted stack has been verified through health, CSRF,
  CORS, DB-backed login rejection and browser-to-API calls.
- The historical Testnet payment (`db354f7f…e47d`) proves on-chain settlement and
  fee splitting. Its memo was `e2e-invoice`, so after invoice-number memo
  binding it no longer qualifies as an invoice-level confirmation replay.
- Wallet flows are implemented with Freighter connect/sign/submit. Five
  Playwright tests mock the provider and API (checkout, fee disclosure, failed
  submission and the landing page); real-extension signing is not covered by CI.
- The mobile app is a read-only PWA (no wallet signing), and the extension does
  not sign transactions.
- Refund approval builds an on-chain transaction only after the indexer has
  linked the contract-assigned refund id; until then it returns `409` rather
  than pretending to submit.
- Redis-backed rate limiting is implemented, but deployments without `REDIS_URL`
  fall back to per-process counters and multiply the quota per replica.
- No external security audit has occurred. The internal review in
  [docs/AUDIT.md](docs/AUDIT.md) is not an audit.

## Architecture

A pnpm + Turborepo monorepo:

```
apps/
  web/                  customer checkout (Next.js)
  api/                  REST API (NestJS + Prisma)
  merchant-dashboard/   merchant operations (Next.js)
  admin-dashboard/      platform administration (Next.js)
  indexer/              Soroban RPC event ingestion
  mobile/               installable PWA (Vite + React)
  extension/            MV3 browser extension
packages/
  contracts/            Soroban contracts (Rust) + tests
  sdk/                  TypeScript SDK
  database/             Prisma schema, migration, client, seed
  types/                shared schemas (zod) and DTOs
  ui/                   shared React components + CSS design system
  hooks/                shared React hooks
  shared/               isomorphic utilities (errors, cursors, webhook HMAC)
  config/               networks, contract env mapping, fee math
tests/e2e/              cross-package tests
docs/                   architecture, API, contracts, key management, runbooks
monitoring/ infra/ helm/ k8s/ gitops/ scripts/
```

Money lives on-chain. The database is an operational projection that the
indexer reconciles from contract events. The API builds unsigned Soroban
transactions for wallets and never reports a payment as settled until the
network returns `SUCCESS`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and
[docs/CONTRACTS.md](docs/CONTRACTS.md) for each contract's state machine and
security assumptions.

## Quickstart

Prerequisites: Node.js ≥ 20, pnpm 12.16.1, Rust 1.84+ with the
`wasm32v1-none` target, and either Docker or a local Postgres 16.

```bash
pnpm install
cp .env.example .env            # fill DATABASE_URL and JWT_SECRET
pnpm db:generate
pnpm db:migrate
pnpm db:seed                    # prints a generated admin password
pnpm dev                        # turbo runs api + apps
```

Contracts:

```bash
rustup target add wasm32v1-none
pnpm contracts:test             # 140 tests across 18 suites
pnpm contracts:build            # 16 WASM artifacts
```

Full instructions: [docs/INSTALL.md](docs/INSTALL.md).

## Verification (current checkout)

| Check | Command | Result |
| --- | --- | --- |
| Contract tests | `pnpm contracts:test` | 140 passed, 0 failed (18 suites) |
| Contract WASM build | `pnpm contracts:build` | 16/16 artifacts; hashes match deployed Testnet WASM |
| Testnet deployment | `node scripts/deploy-testnet.cjs` | 16 contracts, all upload/create txs `SUCCESS` |
| Testnet E2E payment | `node scripts/e2e-testnet.cjs` | payment 1 `Settled`, balances and event verified |
| TypeScript typecheck | `pnpm typecheck` | 22/22 tasks pass |
| TypeScript build | `pnpm build` | passes (api, indexer, 3 Next apps, mobile, extension) |
| TypeScript tests | `pnpm test` with `DATABASE_URL`/`REDIS_URL` | 209 passed, 2 skipped (api 145, indexer 27, sdk 13, shared 10, e2e 10, database 4) |
| API coverage | `pnpm --filter @wpay/api test:coverage` | 89.4% statements, 71.12% branches, 92.48% functions; payments 90.03%, invoices 91.95%, operations 91.49%, auth 90.76%, platform 91.97% |
| Browser tests | `pnpm test:browser` | 5 passed (mocked Freighter + API) |
| Live API smoke | built API against local Postgres/Redis | health OK, database/Soroban up, Swagger 200, CORS origin echoed, cookie/CSRF refresh rotation and reuse revocation, merchant ownership 403, unlisted origin 403 |
| Hosted API | `curl https://wpay-api-six.vercel.app/v1/health` and `/v1/health/ready` | 200; Neon and Soroban up; 16/16 contract flags; CSRF cookie `Secure; HttpOnly; SameSite=None`; unknown-account login 401; disallowed origin 403; serverless `/docs` absent |
| Hosted frontends | headless Chromium against all three URLs | pages 200, no "Backend not configured", API calls from each page origin succeed (`health` 200, `csrf` 200, refresh 401 without session) |
| Hosted contracts | Soroban `getContractData` for each recorded id | 16/16 contract instances live on Testnet |
| GitHub Actions | CI + Security workflows | green on `407fd22` (CI 43424685282, Security 43424685181) |
| Production image smoke | Docker image with `NODE_ENV=production`, read-only rootfs, `cap-drop ALL` | `/v1/health` and `/v1/health/ready` 200; `HttpOnly; Secure; SameSite=None` cookies; refresh rotation/reuse enforced |
| Testnet RPC re-check | Soroban `getLedgerEntries` + `getTransaction` | 16/16 contract instances exist; 16/16 create txs and the E2E payment tx `SUCCESS` |
| Dependency audit | `pnpm audit --prod --audit-level=high` | no known production vulnerabilities |
| Rust audit | `cargo audit --file packages/contracts/Cargo.lock` | 1 transitive advisory (RUSTSEC-2026-0387, no compatible fix); triaged in `docs/AUDIT.md` |
| Database schema | `prisma validate` + `generate` | valid |
| Backup restore drill | `scripts/db-restore-drill.sh` | source and restored row counts match; encrypted round-trip passed; local restore ~1s |
| Testnet resources | `pnpm measure:testnet` | recorded fee 82,589 stroops; simulated create 2,419,372 CPU, 83,770 stroops min resource fee, 1,840-byte assembled envelope |

These results come from the commands above in this repository. The hosted rows
were run on 2026-11-13 against the live URLs. The on-chain claim is limited to
the recorded Testnet transactions in [`deployments/`](deployments); no mainnet
behaviour is claimed.

## Security

- No secrets, keys or real credentials are in the repository.
- Every privileged contract entry point requires authorization and an explicit
  role; see the security assumptions in each contract module.
- API auth supports JWT, scoped API keys (`sha256`, prefix-indexed), and Stellar
  wallet signature verification (challenge/response, raw or SEP-53).
- Refresh tokens are opaque, stored as SHA-256 hashes, rotated on every use, and
  reused-token detection revokes the whole token family. They are delivered as
  `HttpOnly`, `Secure` cookies scoped to `/v1/auth`; refresh and logout require a
  matching `x-csrf-token`. Access and CSRF tokens live in memory only, and
  state-changing requests from unlisted browser origins are rejected.
- Production refuses to boot with a placeholder JWT secret, non-HTTPS public
  URLs, or without `REDIS_URL` (unless `ALLOW_IN_MEMORY_RATE_LIMIT=1` is set
  deliberately); `trust proxy` defaults to one hop so rate limits key on the
  client address.
- The hosted deployment runs that fail-closed configuration: real HTTPS
  `API_PUBLIC_URL`/`WEB_PUBLIC_URL`, generated `JWT_SECRET`, Upstash
  `REDIS_URL`, `TRUST_PROXY=1`, `SameSite=None` refresh cookies, and an exact
  `CORS_ORIGINS` allowlist of the three frontend origins. Vercel access tokens
  were rotated on 2026-11-13 and the previous token is revoked; no token is
  stored in the repository.
- Self-service merchants cannot choose their own fee rate; only ADMIN/OPERATOR
  accounts may override the platform default (250 bps).
- Payment and invoice confirmation verifies the contract invocation arguments,
  memo and emitted event before changing database state.
- Webhooks are HMAC-SHA256 signed over `timestamp.body` with replay tolerance.
- All three Next apps send CSP, `X-Frame-Options: DENY`, nosniff,
  referrer-policy and permissions-policy headers in production. The browser
  extension requests host access only for the API origin the user configures.

Please read [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
Do not open public issues for vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Run `pnpm typecheck && pnpm test && pnpm contracts:test && pnpm lint` before
opening a pull request.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components retain their original
licences and notices.
