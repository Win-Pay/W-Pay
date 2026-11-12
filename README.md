# W-Pay

W-Pay is a Stellar/Soroban-native decentralized payment gateway: merchants accept
payments, issue invoices and payment links, hold funds in escrow, process refunds
and subscriptions, and settle to their own treasury wallet — with merchant and
administrator dashboards, an on-chain event indexer and a TypeScript SDK.

> **Status: pre-implementation.** The repository currently contains this README
> only. None of the contracts, services, applications or tooling described below
> have been written yet, and **nothing is deployed** — no contract addresses,
> testnet deployments or production environments exist. Every section marked
> *planned* is a design target, not a claim about working software.

## Why

Existing Stellar payment tooling tends to stop at "send a payment". W-Pay aims at
the full merchant lifecycle — invoicing, disputes through escrow, recurring
billing, fees and treasury accounting — implemented as auditable Soroban
contracts instead of a single custodial service.

## Planned architecture

A pnpm + Turborepo monorepo:

```
apps/
  web/                  customer-facing payment and checkout app (Next.js)
  api/                  REST API (NestJS)
  merchant-dashboard/   merchant operations (Next.js)
  admin-dashboard/      platform administration (Next.js)
  indexer/              Soroban RPC event ingestion and reconciliation
  mobile/               mobile client
  extension/            browser extension
packages/
  contracts/            Soroban contracts (Rust) and their tests
  sdk/                  TypeScript SDK
  database/             Prisma schema and migrations
  types/                shared TypeScript types
  ui/                   shared React components
  hooks/                shared React hooks
  shared/               cross-package utilities
  config/               shared build and lint configuration
tests/  docs/  scripts/  monitoring/  infra/  helm/  k8s/  gitops/
.github/workflows/
```

### Contracts (planned, 16)

`PaymentRouter`, `InvoiceManager`, `EscrowManager`, `RefundManager`,
`SubscriptionManager`, `SettlementManager`, `MerchantRegistry`, `TreasuryVault`,
`FeeManager`, `ConfigurationManager`, `EmergencyPause`, `RoleManager`,
`UpgradeManager`, `PriceOracle`, `Governance`, `ImpactNFT`.

### Stack (planned)

Next.js and React, TypeScript, NestJS, Rust with the Soroban SDK, the Stellar
SDK, PostgreSQL with Prisma, Redis where required, Docker, Kubernetes and Helm,
and GitHub Actions for CI/CD.

## Getting started

There is nothing to build or run yet. Once the workspace is scaffolded this
section will document prerequisites (Node.js, pnpm, Rust and the
`wasm32-unknown-unknown` target, Docker, PostgreSQL) and the local setup steps.

## Roadmap

1. Workspace scaffolding: pnpm workspaces, Turborepo, shared TypeScript and lint
   configuration, CI skeleton.
2. Contracts: role management and configuration first, then payment routing,
   invoices and escrow, then settlement, fees and treasury.
3. API and database: authentication (JWT, API keys, Stellar wallet signature
   verification), merchants, payments, invoices, webhooks.
4. Indexer and SDK against deployed testnet contracts.
5. Frontends: customer app, merchant dashboard, admin dashboard.
6. Security and operations: secret management, scanning, monitoring, deployment
   manifests, backup and disaster-recovery procedures.

No item above is complete today.

## Security

No production deployment exists and no credentials, keys or contract
deployments are committed to this repository. Environment files will be shipped
as examples only; anyone running W-Pay supplies their own credentials and
independently verifies contract deployments. Do not report security issues in
public issues — contact the maintainers privately.

## Contributing

See `CONTRIBUTING.md` once it exists. Until the initial scaffold lands, please
open an issue describing what you intend to work on.

## Licence

W-Pay is released under the MIT Licence; see `LICENSE` (to be added with the
initial scaffold). Components derived from other projects retain their original
copyright notices.
