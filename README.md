# W-Pay

W-Pay is a Stellar/Soroban-native payment gateway: merchants accept payments,
issue invoices and payment links, hold funds in escrow, process refunds and
subscriptions, and settle to their own treasury address — with customer,
merchant and administrator applications, an on-chain event indexer, and a
TypeScript SDK.

> **Deployment status: testnet contracts verified, backend still local.**
> All 16 contracts are deployed to Stellar Testnet with recorded ids and
> transactions, and a full testnet payment has settled and been confirmed
> through the API. The API, Postgres and indexer are not hosted, so the Vercel
> frontends ([web](https://wpay-web.vercel.app),
> [merchant](https://wpay-merchant.vercel.app),
> [admin](https://wpay-admin.vercel.app)) cannot look up invoices, log in or
> take payments yet. See [DEPLOYMENTS.md](DEPLOYMENTS.md) for the verified
> contract ids, transaction hashes, WASM hashes and the end-to-end payment.

## Live deployments

| App | URL | Host |
| --- | --- | --- |
| Customer checkout | https://wpay-web.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-web) |
| Merchant dashboard | https://wpay-merchant.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-merchant) |
| Admin dashboard | https://wpay-admin.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-admin) |

All three are production deployments of the frontends only and return HTTP 200.
They have no API or database behind them yet, so logins and invoice lookups fail
until the backend is hosted. The contracts they would call are live on Testnet;
the missing piece is the backend deployment, not the contracts.

## What is implemented

| Area | State |
| --- | --- |
| 16 Soroban contracts | Implemented in Rust, 140 tests (138 behaviour + 2 resource benchmarks), builds to `wasm32v1-none`; **all 16 deployed to Testnet** |
| REST API (NestJS) | Implemented: auth, merchants, payments, invoices, escrows, refunds, subscriptions, settlements, treasury, webhooks, analytics, audit, health, metrics; 133 tests including real Postgres integration |
| Database (Postgres + Prisma) | Schema, baseline migration, client, seed; transactions and rollbacks covered by integration tests |
| Indexer | Soroban RPC event ingestion, idempotent persistence, checkpoints, dead-letter retry with admin visibility, health/metrics, payment/refund/escrow/settlement projections |
| TypeScript SDK | API client, Soroban gateway, contract call builders, wallet adapters, tests |
| Customer checkout | Invoice lookup, wallet connect, signed Soroban payment submission |
| Merchant dashboard | Login, analytics, payments, invoices, refunds |
| Admin dashboard | Login, health, merchant approval/suspension, emergency pause intents, audit |
| Mobile PWA | Read-only invoice lookup and payment-link sharing |
| Browser extension (MV3) | Invoice lookup popup and checkout-link copying |
| Infrastructure | Docker images, compose, Kubernetes manifests, Helm chart, Prometheus/Alertmanager/Grafana, Argo CD, CI + security workflows |

## What is not implemented / not verified

See [ROADMAP.md](ROADMAP.md), [docs/AUDIT.md](docs/AUDIT.md) and the
[final engineering report](docs/FINAL-ENGINEERING-REPORT.md). Short version:

- **Testnet only.** No mainnet deployment, no real funds, no external audit.
  The Testnet deployer is a throwaway friendbot-funded key, not multisig.
- The API, Postgres, Redis and indexer are not hosted; they run locally or via
  Docker Compose. The hosted Vercel pages therefore cannot process payments.
- Wallet flows are implemented with Freighter connect/sign/submit. Three
  Playwright checkout tests mock the provider and API; real-extension signing is
  not covered by CI.
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
| TypeScript tests | `pnpm test` | 194 passed, 2 skipped (api 133, indexer 25, sdk 12, shared 10, e2e 10, database 4) |
| API coverage | `pnpm --filter @wpay/api test:coverage` | 89.45% statements; payments 90%, invoices 91.48%, operations 91.27%, auth 94.57%, platform 92.93% |
| Browser tests | `pnpm test:browser` | 3 passed (mocked Freighter + API) |
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
  wallet signature verification (challenge/response).
- Webhooks are HMAC-SHA256 signed over `timestamp.body` with replay tolerance.

Please read [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
Do not open public issues for vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Run `pnpm typecheck && pnpm test && pnpm contracts:test && pnpm lint` before
opening a pull request.

## Licence

MIT — see [LICENSE](LICENSE). Third-party components retain their original
licences and notices.
