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
> Two long-running processes do not fit a request-scoped serverless host. They
> are covered by a Vercel daily cron plus a GitHub Actions catch-up every
> 15 minutes (`.github/workflows/maintenance.yml`), both calling
> `GET /v1/internal/maintenance` with `CRON_SECRET`. The route drains due
> webhook deliveries and runs one indexer pass from the durable cursor, so
> missed work is applied rather than lost; `gh workflow run maintenance.yml`
> triggers an immediate pass. Lag is therefore minutes rather than hours
> (GitHub can delay scheduled runs), but real-time behaviour still needs the
> Compose/Kubernetes workers. There is no mainnet deployment and no external
> audit. See [DEPLOYMENTS.md](DEPLOYMENTS.md) for verified contract ids and
> transaction hashes, [docs/VERCEL.md](docs/VERCEL.md) for hosting details and
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
  (no fallback storage); a sixth failed attempt for one address returns
  `429 ACCOUNT_LOCKED`.
- `/v1/auth/csrf` sets a `Secure; HttpOnly; SameSite=None` cookie.
- `GET /v1/internal/maintenance` with the cron bearer secret ran one indexer
  pass over all 16 contracts (656 ms, no failures) and drained webhooks; the
  same route returns `401` without the secret and is hidden (`404`) when
  `CRON_SECRET` is unset.
- Each frontend origin is echoed in `Access-Control-Allow-Origin`; a mutation
  from an unlisted origin returns `403 ORIGIN_FORBIDDEN`.
- Headless Chromium loaded all three frontends, reported **zero CSP
  violations**, and successfully called the API from the page (`/v1/health`
  200, `/v1/auth/csrf` 200, refresh `401` without a session). Each response
  carries a per-request `script-src 'nonce-…' 'strict-dynamic'` policy with no
  `'unsafe-inline'` for scripts.
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
`TRUST_PROXY=1`, `REFRESH_COOKIE_SAMESITE=none`, `WEBHOOK_WORKER=off`,
`CRON_SECRET` (enables the maintenance cron; the same value must exist as a
GitHub repository secret for the 15-minute catch-up workflow), and the 16
`CONTRACT_*_ID` values. The frontends need only the build-time
`NEXT_PUBLIC_API_URL`.

| Resource | Value |
| --- | --- |
| Neon project | `neon-citrine-compass` (free tier, `iad1`) |
| Upstash database | `upstash-kv-indigo-marble` (free tier) |
| Function region | `iad1`, Node.js 26 runtime, 60 s max duration |
| Migrations | 7 applied with `prisma migrate deploy` against the unpooled URL |

Serverless functions are request-scoped, so the 5-second webhook loop and the
indexer cannot stay resident on Vercel. Instead `vercel.json` schedules a daily
cron (`0 2 * * *`, the Hobby plan's maximum frequency) and
`.github/workflows/maintenance.yml` runs every 15 minutes, both against
`/v1/internal/maintenance`. The endpoint requires `Authorization: Bearer
$CRON_SECRET`, drains up to 50 due webhook deliveries and runs one indexer pass
over all 16 contracts from the stored cursors. Work is therefore applied within
minutes (GitHub can delay scheduled runs), not sub-second; attach the
Compose/Kubernetes workers for real-time delivery and indexing. `gh workflow run
maintenance.yml` forces an immediate pass. Without `CRON_SECRET` the endpoint
is hidden (404) and both schedulers fail cleanly.

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
| REST API (NestJS) | Implemented and hosted on Vercel: auth with HttpOnly refresh cookies, CSRF headers, rotating tokens and per-account lockout, merchants, payments, invoices, escrows, refunds, subscriptions, settlements, treasury, webhooks, analytics, audit, health, metrics; 164 tests including real Postgres integration |
| Database (Postgres + Prisma) | Schema, 7 migrations (including refresh-token families and indexer cursor), client, seed; transactions and rollbacks covered by integration tests; hosted on Neon with migrations applied |
| Indexer | Soroban RPC event ingestion with durable cursors, idempotent persistence, checkpoints, dead-letter retry with admin visibility, health/metrics, payment/refund/escrow/settlement projections — implemented; runs as a 15-minute GitHub Actions + daily Vercel cron catch-up, **not** as a 5-second worker |
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
- The API and database are hosted on Vercel/Neon. The **webhook delivery
  worker and indexer** run as a Vercel daily cron plus a GitHub Actions
  catch-up every 15 minutes (`.github/workflows/maintenance.yml`), so
  deliveries and indexed reads lag by minutes rather than hours
  (GitHub can delay scheduled runs under load). Run
  `gh workflow run maintenance.yml` for an immediate catch-up. Neither is a
  resident worker; real-time delivery still needs the long-running Compose or
  Kubernetes processes. Both schedulers require `CRON_SECRET`. The GitHub
  repository secret could not be created from this environment (the available
  token cannot write Actions secrets), so add it in the repository settings
  before relying on the 15-minute cadence; until then the workflow skips with
  a warning and the daily Vercel cron still runs.
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
- Refund approval records the decision without fabricating a transaction:
  until the indexer links the contract-assigned refund id, `POST
  /v1/refunds/:id/approve` returns `transaction: null`. Once linked,
  `POST /v1/refunds/:id/approve-transaction` returns the settlement-wallet
  approval transaction to sign (`409 REFUND_NOT_LINKED` before that).
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
| TypeScript tests | `pnpm test` with `DATABASE_URL`/`REDIS_URL` | 230 passed, 2 skipped (api 164, indexer 29, sdk 13, shared 10, e2e 10, database 4) |
| API coverage | `pnpm --filter @wpay/api test:coverage` | 89.78% statements, 73.07% branches, 92.43% functions; payments 90.03%, invoices 92.28%, operations 91.49%, auth 89.86%, platform 91.97% |
| Browser tests | `pnpm test:browser` | 5 passed (mocked Freighter + API) |
| Live API smoke | built API against local Postgres/Redis | health OK, database/Soroban up, Swagger 200, CORS origin echoed, cookie/CSRF refresh rotation and reuse revocation, merchant ownership 403, unlisted origin 403 |
| Hosted API | `curl https://wpay-api-six.vercel.app/v1/health` and `/v1/health/ready` | 200; Neon and Soroban up; 16/16 contract flags; CSRF cookie `Secure; HttpOnly; SameSite=None`; unknown-account login 401; sixth failure 429 `ACCOUNT_LOCKED`; disallowed origin 403; serverless `/docs` absent |
| Hosted maintenance cron | `GET /v1/internal/maintenance` with and without `CRON_SECRET` | 200 `ok:true` (16 contracts scanned, 454 ms) with the bearer secret after the 2026-11-13 redeploy; 401 without/with a wrong secret; 404 when unset |
| Hosted refund retry | `POST /v1/refunds/:id/approve-transaction` on the deployed API | 401 `UNAUTHORIZED` without a session (route present after the 2026-11-13 redeploy); linked/unlinked/unauthorized behaviour covered by the blockchain integration suite |
| Hosted merchant build | served JavaScript chunk | chunk `app/page-*.js` contains `approve-transaction`, so the retry action ships; CSP nonce headers present |
| Refund approval retry | blockchain integration suite | `POST /v1/refunds/:id/approve-transaction` returns the `approve` intent once the on-chain id is linked, `409 REFUND_NOT_LINKED` before that, and 409 for a wallet that is not the settlement wallet |
| Hosted error mapping | oversized (300 KB) body and malformed JSON against `/v1/auth/login` | `413 PAYLOAD_TOO_LARGE` and `400 BAD_REQUEST` JSON envelopes (not `500 INTERNAL`) |
| Hosted token handling | forged `alg: none` / `HS384` bearer tokens against `/v1/auth/me` | rejected (403 at the edge, 401 `UNAUTHORIZED` from the API); only HS256-issued tokens are accepted |
| Hosted frontends | headless Chromium against all three URLs | pages 200, zero CSP violations, no "Backend not configured"; per-request nonce CSP with `'strict-dynamic'`; API calls from each page origin succeed (`health` 200, `csrf` 200, refresh 401 without session) |
| Hosted contracts | Soroban `getContractData` for each recorded id | 16/16 contract instances live on Testnet |
| GitHub Actions | CI + Security workflows | green on `abb2428` (CI 43449551716, Security 43449552078) |
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
  wallet signature verification (challenge/response, raw or SEP-53). Access
  tokens are signed and verified with `HS256` only, so a token carrying a
  different `alg` header is rejected even if the secret would validate it.
- Failed sign-ins are counted per account in Redis (`LOGIN_MAX_ATTEMPTS=5` in
  `LOGIN_LOCKOUT_MINUTES=15`); the next attempt returns `429 ACCOUNT_LOCKED`
  even with the correct password, and a successful sign-in clears the counter.
  Unknown addresses are counted the same way, so the lock does not reveal which
  accounts exist. This complements the per-IP request quota against
  distributed password guessing.
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
- Every failure is normalized into the documented `ApiErrorBody` envelope;
  body-parser failures keep their status (`413 PAYLOAD_TOO_LARGE`,
  `400 BAD_REQUEST`) instead of being reported as `500 INTERNAL`.
- Webhooks are HMAC-SHA256 signed over `timestamp.body` with replay tolerance.
- All three Next apps send CSP, `X-Frame-Options: DENY`, nosniff,
  referrer-policy and permissions-policy headers in production. The CSP is
  built per request with a nonce (`script-src 'nonce-…' 'strict-dynamic'`), so
  no `'unsafe-inline'` is allowed for scripts; Next stamps the nonce onto its
  script tags because the root layout reads request headers. Inline style
  attributes still require `style-src 'unsafe-inline'`. The browser extension
  requests host access only for the API origin the user configures.
- The maintenance endpoint is disabled unless `CRON_SECRET` is set, only
  accepts the matching bearer token (constant-time comparison), and is the only
  route that triggers background catch-up work.

Please read [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
Do not open public issues for vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Run `pnpm typecheck && pnpm test && pnpm contracts:test && pnpm lint` before
opening a pull request.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components retain their original
licences and notices.
