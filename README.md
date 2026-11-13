# W-Pay

W-Pay is a Stellar/Soroban-native payment gateway: merchants accept payments,
issue invoices and payment links, hold funds in escrow, process refunds and
subscriptions, and settle to their own treasury address — with customer,
merchant and administrator applications, an on-chain event indexer, and a
TypeScript SDK.

> **Deployment status: testnet contracts verified, backend still local.**
> All 16 contracts are deployed to Stellar Testnet with recorded ids and
> transactions, and a full testnet payment has settled on-chain. The API,
> Postgres, Redis and indexer are not hosted, so the Vercel frontends
> ([web](https://wpay-web.vercel.app),
> [merchant](https://wpay-merchant.vercel.app),
> [admin](https://wpay-admin.vercel.app)) cannot log in or take payments until
> `NEXT_PUBLIC_API_URL` points at a deployed backend. The currently hosted
> bundles predate the fail-closed change and still fall back to
> `localhost:4000`; the source in this repository renders a configuration error
> and requires a redeploy. See [DEPLOYMENTS.md](DEPLOYMENTS.md) for verified
> contract ids and transaction hashes, and [docs/VERCEL.md](docs/VERCEL.md) for
> the exact frontend settings.

## Live deployments

| App | URL | Host |
| --- | --- | --- |
| Customer checkout | https://wpay-web.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-web) |
| Merchant dashboard | https://wpay-merchant.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-merchant) |
| Admin dashboard | https://wpay-admin.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-admin) |

All three are production deployments of the frontends only and return HTTP 200.
They have no API or database behind them yet, so the build-time environment must
be set and the backend deployed before logins or payments work. The contracts
they call are live on Testnet; the missing piece is the backend deployment, not
the contracts.

## What is implemented

| Area | State |
| --- | --- |
| 16 Soroban contracts | Implemented in Rust, 140 tests (138 behaviour + 2 resource benchmarks), builds to `wasm32v1-none`; **all 16 deployed to Testnet** |
| REST API (NestJS) | Implemented: auth with HttpOnly refresh cookies, CSRF headers and rotating tokens, merchants, payments, invoices, escrows, refunds, subscriptions, settlements, treasury, webhooks, analytics, audit, health, metrics; 145 tests including real Postgres integration |
| Database (Postgres + Prisma) | Schema, 7 migrations (including refresh-token families and indexer cursor), client, seed; transactions and rollbacks covered by integration tests |
| Indexer | Soroban RPC event ingestion with durable cursors, idempotent persistence, checkpoints, dead-letter retry with admin visibility, health/metrics, payment/refund/escrow/settlement projections |
| TypeScript SDK | API client with automatic refresh retry, Soroban gateway, contract call builders, wallet adapters, tests |
| Customer checkout | Invoice lookup, merchant branding, transparent fee split, wallet connect/disconnect, signed Soroban payment, progress and receipt with Explorer link; success only after backend verification. A separate `/landing` page presents the product |
| Merchant dashboard | Email or wallet login, wallet onboarding, analytics, payments, invoices, refunds, settlement batches, subscriptions, webhooks and API keys |
| Admin dashboard | Email or wallet login, health, merchant approval/suspension, emergency pause intents, audit log, indexer failures, treasury withdrawals, settlement batches |
| Mobile PWA | Read-only invoice lookup and payment-link sharing |
| Browser extension (MV3) | Invoice lookup popup and checkout-link copying; host access is requested per configured API origin (`optional_host_permissions`) |
| Infrastructure | Docker images, development and production Compose, Caddy HTTPS, Kubernetes manifests, Helm chart, Prometheus/Alertmanager/Grafana, Argo CD, CI + security workflows |

## What is not implemented / not verified

See [ROADMAP.md](ROADMAP.md), [docs/AUDIT.md](docs/AUDIT.md) and the
[final engineering report](docs/FINAL-ENGINEERING-REPORT.md). Short version:

- **Testnet only.** No mainnet deployment, no real funds, no external audit.
  The Testnet deployer is a throwaway friendbot-funded key, not multisig.
- The API, Postgres, Redis and indexer are not hosted; they run locally or via
  Docker Compose. The currently hosted Vercel bundles still point at
  `localhost:4000`; rebuild them with `NEXT_PUBLIC_API_URL` after the backend is
  deployed.
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
| Production image smoke | Docker image with `NODE_ENV=production`, read-only rootfs, `cap-drop ALL` | `/v1/health` and `/v1/health/ready` 200; `HttpOnly; Secure; SameSite=None` cookies; refresh rotation/reuse enforced |
| Testnet RPC re-check | Soroban `getLedgerEntries` + `getTransaction` | 16/16 contract instances exist; 16/16 create txs and the E2E payment tx `SUCCESS` |
| Dependency audit | `pnpm audit --prod --audit-level=high` | no known production vulnerabilities |
| Rust audit | `cargo audit --file packages/contracts/Cargo.lock` | 1 transitive advisory (RUSTSEC-2026-0387, no compatible fix); triaged in `docs/AUDIT.md` |
| Database schema | `prisma validate` + `generate` | valid |
| Backup restore drill | `scripts/db-restore-drill.sh` | source and restored row counts match; encrypted round-trip passed; local restore ~1s |
| Testnet resources | `pnpm measure:testnet` | recorded fee 82,589 stroops; simulated create 2,419,372 CPU, 83,770 stroops min resource fee, 1,840-byte assembled envelope |

These results come from the commands above in this repository. The on-chain
claim is limited to the recorded Testnet transactions in
[`deployments/`](deployments); no mainnet behaviour is claimed.

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
