# Testnet verification

This page records what has been checked on Stellar Testnet, the exact commands,
and what remains unverified. Contract ids, WASM hashes and deployment
transactions are in [DEPLOYMENTS.md](../DEPLOYMENTS.md); this page does not
repeat them.

W-Pay is **Testnet only**. There is no mainnet deployment, no real funds and no
external audit.

## What the recorded evidence covers

| Check | Date | Evidence |
| --- | --- | --- |
| 16 contract uploads and creates | 2026-11-12 | Every `upload`/`create` transaction `SUCCESS`; record in `deployments/testnet.json` |
| Contract instances exist | 2026-11-13 | Read-only Soroban RPC `getContractData(..., LedgerKeyContractInstance)` for all 16 ids |
| WASM hashes match local build | 2026-11-12 | 16/16 `wasmSha256` values match the local `wasm32v1-none` artifacts byte-for-byte |
| End-to-end payment | 2026-11-12 | `PaymentRouter` payment tx `db354f7f04a6703b66f37a916c6e4994a017dd45c3689923e43cd9476257e47d`, ledger 5698164; `Settled`; fee 250000, net 9750000, treasury/merchant balances match |
| API confirmation of that payment | locally against Testnet | Payment `SETTLED`, `contractPaymentId=1`; the memo was `e2e-invoice`, so it does not qualify as an invoice-number replay after memo binding |
| Resource measurement | 2026-11-12 | `pnpm measure:testnet`: recorded fee 82,589 stroops; simulated `create_payment` 2,419,372 CPU, 83,770 stroops minimum resource fee, 1,840-byte assembled envelope |

The end-to-end payment proves `PaymentRouter` settlement and fee splitting. It
does **not** prove a batched `SettlementManager.execute`, invoicing, escrow,
refund or subscription flow on the live network.

## Prerequisites

- Node.js 20+ and pnpm 12.16.1.
- `SOROBAN_SOURCE_SECRET` only for deployment or the end-to-end script. Never
  commit it or paste it into a shell history you share.
- Outbound access to `https://soroban-testnet.stellar.org` and
  `https://horizon-testnet.stellar.org`.
- The Rust toolchain with `wasm32v1-none` to rebuild WASM artifacts locally. If
  `cargo` is unavailable, hash re-verification is **BLOCKED**; do not claim it.

## Verify the deployed contracts

Re-running the deployment script is the supported read-first check. It resumes
from `deployments/testnet.json` and skips contracts already recorded after
reading the instance on chain:

```bash
SOROBAN_SOURCE_SECRET=S... node scripts/deploy-testnet.cjs
```

Expected: one line per contract (`already deployed <id>, skipping`) and a final
count of 16. A recorded id that still exists on chain is skipped. If a recorded
instance is **missing** on chain, the script deploys a new instance and
overwrites that entry in `deployments/testnet.json`; inspect the output and the
diff before committing, and never use a missing instance as a reason to accept a
new id silently.

To check an individual contract without a secret:

```bash
stellar contract invoke \
  --id CDKHZJ2PHJZ5VLS4AXJK3BYJ244XYEAFE23NLJ6YA7Q76RKSE4IREGHP \
  --network testnet -- get_admin
```

A successful read returns the admin address. A `404`/not-found means the id is
wrong or the instance no longer exists.

## Re-run the end-to-end payment

```bash
SOROBAN_SOURCE_SECRET=S... node scripts/e2e-testnet.cjs
```

The script deploys a test SAC, creates trustlines, mints tokens, initializes
`FeeManager`, `MerchantRegistry` and `PaymentRouter`, registers and approves a
merchant, then pays once. It verifies the event and balances and writes
`deployments/testnet-e2e.json`. Re-running verifies the recorded payment instead
of paying twice; do not force a second payment by deleting the record.

Expected success marker: `payment.status = "Settled"`, `eventVerified = true`,
`treasuryBalance = "250000"`, `merchantBalance = "9750000"` for the recorded
`10000000` stroop payment at 250 bps.

## Measure current network resources

```bash
pnpm measure:testnet
```

This reads the recorded payment over RPC and Horizon, then simulates a fresh
`create_payment` with the recorded payer as source. It loads no secret, signs
nothing and submits nothing. The fee it prints is a network simulation estimate,
not a charge.

## Verify the hosted API

The hosted API is at `https://wpay-api-six.vercel.app` (see the README for the
deployment record):

```bash
curl -s https://wpay-api-six.vercel.app/v1/health | jq
curl -s -o /dev/null -w '%{http_code}\n' https://wpay-api-six.vercel.app/v1/health/ready
```

Expected: `status: "ok"`, `database: "up"`, `soroban: "up"`, 16 `contracts`
entries all `true`, and `200` from `/v1/health/ready`. The response also reports
`redis` (`up`, `down` or `not_configured`) and `indexer`
(`up`, `stale` or `not_started`). Indexer lag is visibility only; it never makes
readiness fail.

These checks were last recorded on 2026-11-13. Re-run them before quoting them;
hosting and contract state can change.

## Verify the wallet flow

The checkout and dashboards are exercised in CI with a mocked Freighter provider
and mocked API (`pnpm test:browser`). That proves the UI contract: network guard,
one submission, failure handling, and no "paid" state without a network result.

It does **not** load the real extension, and no hosted payment with real
Freighter signing has been recorded. Treat real-extension E2E as unverified
until someone performs it and records the transaction hash, network, wallet
address and result.

## What is BLOCKED here

- **WASM hash re-verification in this checkout:** `cargo` is not installed in
  this environment, so the local artifacts cannot be rebuilt and compared. CI
  has Rust; run `pnpm contracts:build` and compare hashes there.
- **A new on-chain payment:** requires a funded key and explicit authorization.
  Do not reuse the throwaway deployer key as a production or long-lived admin.
- **Settlement, invoice, escrow, refund and subscription E2E on Testnet:** not
  performed. The scripts and intents exist; no recorded live run does.
- **Mainnet:** out of scope until an independent audit and a key ceremony.

## Reporting a verification

When adding evidence, include the command, date, network, transaction hash,
ledger, contract id and the observed result. Do not paste secrets, seed phrases
or full signed envelopes. A result that was not run must be labelled
**BLOCKED** or **NOT RUN**, not inferred from another run.
