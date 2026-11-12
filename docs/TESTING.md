# Testing

## Contract tests

```bash
pnpm contracts:test
```

138 tests across 18 test binaries run on the Soroban test host. They cover
access control, pause behaviour, state transitions, fee math, overflow, nested
auth, and cross-contract calls. Snapshot files under `test_snapshots/` record
ledger/auth intersections for key scenarios.

Known pitfall: `mock_all_auths()` does not satisfy nested auth when a
non-root contract authorizes the outer call. Refund tests therefore authorize
with the merchant settlement address explicitly.

Integration tests (`packages/contracts/integration-tests`) run as part of the
same `cargo test` invocation.

## TypeScript tests

```bash
pnpm test
```

52 tests pass, 2 are skipped, across six packages:

| Package | Tests | Focus |
| --- | --- | --- |
| `@wpay/shared` | 10 | Cursor encoding, webhook HMAC/verification, wallet messages, error mapping |
| `@wpay/sdk` | 11 | HTTP client, call builders, Soroban gateway, wallet signers |
| `@wpay/database` | 4 | Cursor paging, bigint serialization, migration helpers |
| `@wpay/api` | 10 | Access rules, API-key hashing/scopes, DTO validation, error envelope |
| `@wpay/indexer` | 7 | Event decoding, `jsonSafe`, `planPaymentUpdate`, token hashing |
| `@wpay/e2e` | 10 (+2 skipped) | Env-name mapping vs `.env.example`, fee/amount parity, call construction, wallet message, webhook tamper tests; live-API tests skip unless `WPAY_E2E_API_URL` is set |

These tests do not require a database. Anything that needs Postgres (end-to-end
API flows) is intentionally not claimed as covered.

Tests use real Stellar keys (`Keypair.random()`) because `Address` validates the
StrKey checksum; placeholder strings fail validation by design.

## Build and type checks

```bash
pnpm typecheck
pnpm build
pnpm lint
```

`pnpm build` builds API, indexer, the three Next apps and the mobile PWA and
verifies the packages compile. `@stellar/stellar-sdk` uses the `rpc` namespace
in v13.

Environment for all commands:

```bash
export DATABASE_URL="postgresql://wpay:wpay@localhost:5432/wpay?schema=public"
export JWT_SECRET="test-secret-that-is-long-enough-for-validation"
```

## Manual smoke test (no deployment required)

1. Start Postgres, run migrations and seed.
2. `pnpm dev`.
3. `GET /v1/health` → `database: "up"`, `contracts: {}` (none deployed).
4. Log in to the merchant dashboard with the seeded admin, create a merchant and
   invoice, open the public checkout, and look up the invoice number.
5. Confirm that without contract ids the payment intent returns `503` — this is
   the correct, honest behaviour, not a failure.

## What is not tested

- On-chain execution against a live network (no deployment exists).
- Wallet extensions (Freighter) — the adapter is unit tested, interaction is not.
- Browser E2E (no Playwright suite).
- Load/performance and disaster-recovery drills.
