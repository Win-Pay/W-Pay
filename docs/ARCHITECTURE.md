# Architecture

## Principles

1. **The chain is the source of truth for money.** Contract state decides whether
   funds moved. The database is an operational projection that the indexer
   reconciles from contract events; it never authorizes a transfer.
2. **The platform never holds customer keys.** Wallets sign; the API builds
   unsigned transactions (XDR) and submits only what a user signed.
3. **Honest state.** A payment is `SETTLED` only after the network returns
   `SUCCESS` and the indexer observes the contract event. Missing configuration
   produces explicit `503`/`null`, never a simulated success.
4. **Least privilege.** Each contract has its own admin/operator roles; the API
   separates customer, merchant, operator and admin access.

## Components

```
                    ┌────────────────────┐
  customer ────────▶│ web (Next.js)      │──┐
  merchant ────────▶│ merchant-dashboard │──┤   HTTPS/JSON
  operator ────────▶│ admin-dashboard    │──┤
  mobile/extension ─┴────────────────────┘  ▼
                                     ┌──────────────┐        ┌────────────┐
                                     │ api (NestJS) │───────▶│ PostgreSQL │
                                     └──────┬───────┘        └─────▲──────┘
                                            │ build/submit XDR      │ projection
                                     ┌──────▼───────┐        ┌──────┴──────┐
                                     │ Soroban RPC  │◀───────│  indexer    │
                                     └──────┬───────┘ events └─────────────┘
                                            │
                                     ┌──────▼──────────────────────────────┐
                                     │ 16 Soroban contracts (Stellar)      │
                                     └─────────────────────────────────────┘
```

### `apps/api`
NestJS + Prisma. Modules:

- `auth` — register/login (bcrypt, cost 12), JWT access tokens, scoped API keys,
  SEP-53 wallet challenge/verify.
- `merchants` — registration, profile, approval/suspension, settlement address.
- `payments` — create payment or payment intent, idempotent by
  `(merchantId, idempotencyKey)`, confirm by transaction hash, public submit.
- `invoices` — merchant invoices plus public checkout endpoints.
- `operations` — escrows (release/refund/dispute/resolve), refunds
  (approve/reject), subscriptions (plans, subscribe, cancel).
- `platform` — health/readiness/metrics, analytics, settlements, treasury
  withdraw intents, API keys, notifications, admin actions, public transaction
  submission.
- `webhooks` — subscription management, HMAC-signed delivery, retries with
  backoff, delivery log.

Request flow: controller → zod validation (`@wpay/types`) → Prisma transaction →
`@wpay/sdk` builder/Soroban gateway → response DTO. Cross-cutting concerns:
global exception filter with a stable error envelope, audit log on every
privileged mutation, rate limiting, request correlation ids.

### `apps/indexer`
Polls Soroban RPC `getEvents` from a persisted checkpoint, decodes contract
events, and applies them in idempotent upserts keyed by ledger + event id.
`planPaymentUpdate` is a pure function so status transitions can be tested
without a database. Exposes `/health` and `/metrics`.

### `packages/contracts`
16 Soroban contracts plus `wpay-common` (shared types, access control, pause,
validation, token helpers, generated clients). The integration-test crate
exercises cross-contract lifecycles (merchant registration → payment → fee
split → refund) on the Soroban test host.

### `packages/sdk`
`HttpClient` (timeouts, retries, error mapping), `WPayApi` resource client,
`SorobanGateway` (simulate/assemble/submit/poll), typed call builders, and
wallet adapters (Freighter + raw secret-key signer). Shared by apps and
`tests/e2e`.

## Money flow

1. Merchant registers off-chain and on-chain (registry) with a settlement
   address.
2. Customer requests a payment intent. The API validates the merchant's active
   status and fee, then builds an unsigned transaction calling
   `payment-router.create_payment(amount, asset, merchant_id, memo, invoice)`.
3. The wallet signs; the customer (or the API on their behalf) submits. The
   router pulls funds from the payer into contract custody and emits a
   `payment` event with the assigned id and fee split.
4. The indexer records the payment, its fee split and settlement state.
5. Settlement moves net funds to the merchant's settlement address and the fee
   to the treasury, emitting settlement events.
6. Refunds are approved by the merchant settlement address (funds owner), then
   executed by the refund manager; escrows follow their own state machine.

Amounts are `i128` base units; the fee manager applies basis points with
floor rounding, and the router enforces `fee <= gross`. Splitting is exact:
`net = gross - fee`.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| RPC unavailable | Intent returns `503`; nothing recorded as paid |
| Transaction `FAILED` | Payment stays `PENDING` with the failure reason stored |
| Indexer lag | Dashboards show projection timestamp; settlement waits on confirmation |
| Duplicate webhook | Idempotency key per event; delivery log deduplicates |
| Duplicate payment request | Same idempotency key returns the original record |
| Pause triggered | Contract-level pause rejects mutations; API surfaces the reason |

## Deployment topology

Stateless API and Next.js pods behind an ingress; a single indexer replica
(leader) with a Postgres advisory lock; managed Postgres with PITR. See
[docs/DEPLOYMENT.md](DEPLOYMENT.md).
