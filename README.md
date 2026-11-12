# W-Pay

W-Pay is a Stellar/Soroban-native payment gateway: merchants accept payments,
issue invoices and payment links, hold funds in escrow, process refunds and
subscriptions, and settle to their own treasury address — with customer,
merchant and administrator applications, an on-chain event indexer, and a
TypeScript SDK.

> **Deployment status: frontend hosting only.** The checkout and both
dashboards are hosted on Vercel: [wpay-web](https://wpay-web.vercel.app),
> [wpay-merchant](https://wpay-merchant.vercel.app),
> [wpay-admin](https://wpay-admin.vercel.app). No contract is deployed to any
> Stellar network, and no API, database or indexer is deployed — so the live
> pages cannot look up invoices, log in or take payments yet. Contract
> addresses in `.env.example` are empty on purpose; see
> [DEPLOYMENTS.md](DEPLOYMENTS.md) for verified deployment records.

## Live deployments

| App | URL | Host |
| --- | --- | --- |
| Customer checkout | https://wpay-web.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-web) |
| Merchant dashboard | https://wpay-merchant.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-merchant) |
| Admin dashboard | https://wpay-admin.vercel.app | [Vercel](https://vercel.com/w-pay/wpay-admin) |

All three are production deployments of the frontends only and return HTTP 200.
They have no API or database behind them yet, so logins and invoice lookups fail
until the backend is deployed.

## What is implemented

| Area | State |
| --- | --- |
| 16 Soroban contracts | Implemented in Rust, unit + integration tested, builds to `wasm32v1-none` |
| REST API (NestJS) | Implemented: auth, merchants, payments, invoices, escrows, refunds, subscriptions, settlements, treasury, webhooks, analytics, audit, health, metrics |
| Database (Postgres + Prisma) | Schema, baseline migration, client, seed |
| Indexer | Soroban RPC event ingestion, idempotent persistence, checkpoints, health/metrics |
| TypeScript SDK | API client, Soroban gateway, contract call builders, wallet adapters, tests |
| Customer checkout | Invoice lookup, wallet connect, signed Soroban payment submission |
| Merchant dashboard | Login, analytics, payments, invoices, refunds |
| Admin dashboard | Login, health, merchant approval/suspension, emergency pause intents, audit |
| Mobile PWA | Read-only invoice lookup and payment-link sharing |
| Browser extension (MV3) | Invoice lookup popup and checkout-link copying |
| Infrastructure | Docker images, compose, Kubernetes manifests, Helm chart, Prometheus/Alertmanager/Grafana, Argo CD, CI + security workflows |

## What is not implemented / not verified

See [ROADMAP.md](ROADMAP.md) and the final section of [docs/AUDIT.md](docs/AUDIT.md).
Short version:

- **No deployed contracts**, therefore no live end-to-end payment has been
  exercised against a network. Contract behaviour is verified by tests on the
  Soroban test host, not on-chain.
- API integration tests against a real Postgres are not in the repo; API tests
  cover pure logic (access rules, API keys, validation, serialization).
- Refund approval records the decision but cannot build an on-chain transaction
  until the indexer links the contract-assigned refund id to the record.
- The mobile app is a read-only PWA (no wallet signing), and the extension does
  not sign transactions.
- Redis-backed rate limiting is not implemented; the limiter is in-process, so
  limits are per replica.
- There is no external security audit.

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
docs/                   architecture, API, contracts, runbooks
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
pnpm contracts:test             # 138 tests across 18 suites
pnpm contracts:build            # 16 WASM artifacts
```

Full instructions: [docs/INSTALL.md](docs/INSTALL.md).

## Verification (current checkout)

| Check | Command | Result |
| --- | --- | --- |
| Contract tests | `pnpm contracts:test` | 138 passed, 0 failed |
| Contract WASM build | `pnpm contracts:build` | 16/16 artifacts, 20–41 KB |
| TypeScript typecheck | `pnpm typecheck` | passes |
| TypeScript build | `pnpm build` | passes (api, indexer, 3 Next apps, mobile) |
| TypeScript tests | `pnpm test` | 52 passed, 2 skipped (shared 10, database 4, api 10, sdk 11, indexer 7, e2e 10; live-API tests skip without `WPAY_E2E_API_URL`) |
| Database schema | `prisma validate` + `generate` | valid |

These results come from the commands above in this repository; they are not a
claim about on-chain behaviour.

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
