# Testnet verification

Last updated: 2026-11-23. This page records what has been checked on Stellar
Testnet, the exact commands, and what remains unverified. Contract ids, WASM
hashes and deployment transactions for the original 16-contract deployment are
in [DEPLOYMENTS.md](../DEPLOYMENTS.md); the isolated five-contract run below has
its own records in [`deployments/`](../deployments).

W-Pay is **Testnet only**. There is no mainnet deployment, no real funds and no
external audit.

## Current status at a glance

| Area | Status | Evidence |
| --- | --- | --- |
| Original 16 contracts | PASS (Testnet) | Upload/create txs `SUCCESS`; read-only RPC re-check; WASM hashes matched |
| Isolated invoice + settlement contracts | PASS (Testnet) | Five contracts deployed 2026-11-22; WASM hashes match local build |
| On-chain invoice payment | PASS (Testnet) | Invoice 2 created and paid; events and balance deltas verified |
| Manual settlement windows | PASS (Testnet) | Windows 1 and 2 executed; underfunded and duplicate executions rejected |
| Automatic settlement | PASS (Testnet, supervised) | API maintenance claimed payment, created and executed window 4 on chain |
| Indexer catch-up and dead letters | PASS (local API + scratch Postgres) | Checkpoints advanced, projection applied, dead letters reviewed, second pass idempotent |
| Whole checkout with real Freighter | PASS (Testnet, local) | Varial 5.53.0 run 2026-11-23: tx `c21ae165…0092`, ledger `5881013`; invoice `PAID`, payment `SETTLED` |
| Hosted API running this code | BLOCKED | `/v1/admin/settlements/automation` returns `404` on the hosted deployment |
| Production backup workflow | BLOCKED | `production` environment has no `DATABASE_URL`; last scheduled run failed |
| Independent audit | BLOCKED | No external audit has been performed |

## Isolated five-contract deployment (2026-11-22)

Deployed with `DEPLOYMENTS_FILE=deployments/testnet-invoice-deployments.json`,
`CONTRACTS=feeManager,merchantRegistry,paymentRouter,invoiceManager,settlementManager`
and a throwaway Friendbot-funded test key. The original 16-contract record was
not modified. Upload and create transactions are recorded in
[`deployments/testnet-invoice-deployments.json`](../deployments/testnet-invoice-deployments.json).

| Contract | Contract id | WASM SHA-256 |
| --- | --- | --- |
| `paymentRouter` | `CCH5OCHWK7FMVMAZKVTHORNVSWOBXJX5RM5U7KSBYQFG2AOTGXGL5NHM` | `26028f4f5363f978883954e9c3c0bc7577158eb56a00941f0f41f19b1cb11412` |
| `invoiceManager` | `CDNE2XG4A7D7XI7OW3G2KDCZAQDD4XHAVAPAHT2XKAZUI46WM3AJOOSV` | `85e636ca08b27470eca815696086daa954115401d9e2b345b0d74b2e9acf4cf3` |
| `settlementManager` | `CCSEVPCYVMDPW3ZM4CKFJZJ2Q464FJR7ONE62WM4AEW6XOEYKYASXW4J` | `a4900184f94ae5bad709f68f72cfcda82dea70212ecfb74526aa28392f5e604a` |
| `merchantRegistry` | `CBPJKD3YEXZXSFGWGC77N3FNB2VDNIDXDVKCQJA54H7MQQ5HU5OEHXDI` | `1be2be1cd4e59993bb1be2d41806a414699f619c981e1fb9647311ac8ca3f8da` |
| `feeManager` | `CCNSHK7VXUK6646HMWFOPY7K3TEAHH6DSNTY2Z2KAHGBY4LZ76MODY7Y` | `f48e82e992663198e4e24101ac93fcfc072b6dd09b16de48bc119bfe4bc1aca8` |

`pnpm contracts:build` produced the five artifacts locally and the on-chain
hashes matched. The full 16-contract hash comparison is recorded in
[DEPLOYMENTS.md](../DEPLOYMENTS.md).

A local test SAC (`WPAYINV`, issuer `GCNI62OIMAEADUTRCMPSP3PNO2W4ORZ6HAJUWQYF6ZUPRUXFXZ42CRV4`)
was created at `CAM7IBX7FDGGXLBMBO2F7VYTV5ERZUBQ7NXOKSSOT5AWAPVIYCMCH2YD`; the
mint transaction was `d49616beafd2c320e68bf6e97513755e00a6474aef2fddd09e509ed884965580`.
Merchant 1 (`GCQVC6RHBCVSQ5BPFBIYFYRN5E6KSDF53ZUJ3KU5AOAWRK5ZRIW4H2MQ`) was
registered and approved with transactions `044c02025e5c63f739db9b727cbb65e3e9d9ad6b07ecfaf5834a4e292cedbd7e`
and `c7c5ed0809129c2178df71cb060d4f54dc2dbb3ca5bdbe8f51918aeda42bbd1a`.

## Real invoice payment (2026-11-22)

The full machine-readable record is
[`deployments/testnet-invoice-e2e.json`](../deployments/testnet-invoice-e2e.json).

| Field | Value |
| --- | --- |
| Invoice contract id | `2` |
| Memo | `invoice-1795382714` |
| Amount / fee / net | `5,000,000` / `125,000` / `4,875,000` stroops |
| Create tx / ledger | `e1df66667e8c9107f5be75b2e3f5f12c968f6686714ef6a05b84fab4151ae867` / `5871815` |
| Payment tx / ledger | `22f2405878a07068d2cf4cedb3b4718de5a7a618a1cff60d56edf2e68a6137dd` / `5871816` |
| Contract payment id | `2` |
| Invoice / payment status | `Paid` / `Settled` |
| Payer balance | `100,000,000` → `95,000,000` |
| Treasury balance | `125,000` → `250,000` |
| Merchant balance | `4,875,000` → `9,750,000` |

The `invoice`, `payment` and `paid` events were read back over Soroban RPC from
the same transaction. The invoice event carried merchant `1` and amount
`5,000,000`; the payment event carried payer
`GA2DMDCDMMTE3L3NDE6BC2WRMK7IHC7K6XQ4UHK3AMDZDT7Z3ME6R3SA`, payment `2`,
amount `5,000,000` and fee `125,000`. The observed balance deltas equal the
contract's 250 bps split exactly.

This proves the on-chain invoice lifecycle and fee arithmetic with a generated
Testnet keypair. It does **not** prove a browser checkout signed by the real
Freighter extension; see [Wallet flow](#wallet-flow) below.

## Manual settlement windows (2026-11-22)

The same run exercised `SettlementManager` windows:

| Check | Result |
| --- | --- |
| Window 1 open/entry/close/fund/execute | Txs `0e6567dd…2daf`, `07c7221f…3894`, `7f1f3eb7…0653`, `e108b087…07bc`, `99ef0d30…4134`; `Executed`; total `4,875,000`; merchant `9,750,000` → `14,625,000`; pool `0` |
| Window 1 execute event | `execute` topic with window `1`, operator `GCNI62OIMAEADUTRCMPSP3PNO2W4ORZ6HAJUWQYF6ZUPRUXFXZ42CRV4`, amount `4,875,000` |
| Window 2 underfunded execute | Rejected in simulation with `Error(Contract, #7)`; nothing was submitted |
| Window 2 funded execute | Txs `86f58e98…370f`, `9f44037e…35b9`, `b55f62c1…32ea`; `Executed` |
| Window 2 duplicate execute | Rejected in simulation with `Error(Contract, #8)` |
| Automation pool funding | Tx `5280fee6426b4a9ec918dc0df988eb96b73c19149109406209a1ad8c78170d29`, ledger `5871829`, amount `4,875,000` |

The rejection tests are simulation-level only: the rejected calls were never
submitted. That is the expected way to demonstrate a contract precondition
without burning a failed transaction, and the accepted calls were submitted and
confirmed.

## Automatic settlement through the API (2026-11-22)

The on-chain events were also replayed into a scratch PostgreSQL database and
indexed by the real API process. A local `GET /v1/internal/maintenance` call
(authenticated with the test `CRON_SECRET`) then ran the configured `execute`
mode against Testnet.

| Field | Value |
| --- | --- |
| Source invoice | `INV-2026-0002`, contract invoice `2`, database status `PAID` |
| Source payment | contract payment `2`, database status `SETTLED`, tx `22f24058…37dd` |
| Automation window | `4` |
| Batch key | `auto:CAM7IBX7FDGGXLBMBO2F7VYTV5ERZUBQ7NXOKSSOT5AWAPVIYCMCH2YD:2026-11-22T21:29:18.600Z:5afd3bf8` |
| Total / entries | `4,875,000` / one payee, one payment |
| Status | `EXECUTED`, attempts `0`, no last error |
| Contract txs | `864391c9…130f` (ledger `5871864`), `0a59385d…164f` (`5871865`), `4cc8c9e2…2914` (`5871866`), `921f5836…4319` (`5871867`) — all `SUCCESS` |
| Audit | `settlement.auto.execute`, entity `cmwscnoya000o8ftjxvegiyvm` |

The first maintenance pass reported one batch created, one payment assigned,
`assignedTotal: 4875000`, one execution attempted and executed, and no errors.
The indexer checkpoints advanced for all five contracts (payment router, invoice
manager and settlement manager to `5871867`; merchant registry and fee manager
to `5871868`). The machine-readable record is
[`deployments/testnet-invoice-automation.json`](../deployments/testnet-invoice-automation.json).

Idempotency and recovery checks from the same record:

- A second observation and a final stable pass fetched/inserted/applied events
  without creating a second payment or batch. Final pass: fetched `0`,
  inserted `0`, failed `0`.
- `unresolvedIndexerFailures: 0`; one automation window exists for the source
  payment; the payment holds one claim.
- Four expected dead letters came from the unseeded negative invoices created
  on chain during this run. They were listed with their tx hashes, reviewed with
  an operator account and resolved through the audited endpoint
  (`unresolvedAfter: 0`). No existing payment or settlement batch was modified.
- The automation worker was run in a supervised local process. This is not
  evidence that the hosted Vercel deployment has the migration or the code.

## Negative tests (2026-11-22)

Rejected calls are recorded only when the contract or RPC actually rejected
them. Three requested negative cases do not exist as separate contract paths;
they are marked `notApplicable` rather than fabricated.

| Case | Result |
| --- | --- |
| Duplicate invoice payment | Rejected: `Error(Contract, #8)` |
| Non-owner invoice creation | Rejected: `Error(Contract, #3)` |
| Unsupported token payment | Rejected: `Error(Storage, MissingValue)`; the invoice was then cancelled |
| Expired invoice payment | Rejected: `Error(Contract, #9)`; invoice marked `Expired` |
| Wrong amount | **notApplicable** — `InvoiceManager.pay` consumes the stored amount; the caller cannot supply one |
| Wrong invoice reference | **notApplicable** — the contract takes the invoice id and treats the memo as opaque text; off-chain reference matching is an API concern |
| Invalid transaction hash / replay | **notApplicable** as a contract input; replay is covered by the duplicate-payment rejection |

The wrong-amount and wrong-reference protections live in the API verification
path and its tests, not in `pay`. Do not describe this table as covering them.

## Indexer reliability evidence

The maintenance runs recorded above exercised the real indexer against live
events:

- Durable checkpoints with cursors exist for all five contracts and advanced
  past the payment and settlement ledgers.
- The first pass fetched and inserted `19` events and applied `12` projections;
  failed projections were `0`.
- The negative invoices that were deliberately not seeded in the database
  produced four dead letters instead of guessed projections. They were visible
  with event ids and tx hashes and were resolved through the operator endpoint.
- Re-running maintenance produced no duplicate payment, no duplicate settlement
  window and no new batch.
- The stable pass recorded `fetched: 0, inserted: 0, failed: 0`.

This is a supervised catch-up test, not a multi-hour outage or load test. The
hosted deployment still runs the indexer as a periodic maintenance call, not as
a resident worker.

## Reproduce

Contract deployment (uses a local secret file that must never be committed):

```bash
DEPLOYMENTS_FILE=deployments/testnet-invoice-deployments.json \
SECRET_FILE=.env.testnet-invoice.local \
CONTRACTS=feeManager,merchantRegistry,paymentRouter,invoiceManager,settlementManager \
node scripts/deploy-testnet.cjs
```

Invoice, settlement and negative flow:

```bash
NODE_PATH=packages/sdk/node_modules \
  node scripts/e2e-invoice-testnet.cjs
```

Use `--skip-negatives` to reuse the recorded positive flow or
`--negatives-only` after a completed invoice. The script verifies recorded
transactions instead of paying twice; do not delete the evidence file to force a
second payment. It writes
`deployments/testnet-invoice-e2e.json` and keeps the deployment record separate
from the original `deployments/testnet.json`.

The API automation run additionally needs a migrated scratch Postgres, a local
API process with `SETTLEMENT_AUTOMATION=execute`, the five `CONTRACT_*_ID`
variables from the isolated deployment, a funded settlement pool and
`CRON_SECRET`. The exact transaction set is in the automation record above.

## Verify the hosted API

The hosted API is at `https://wpay-api-six.vercel.app`. The settlement metrics
listed in [SETTLEMENT.md](SETTLEMENT.md#metrics) are only present once the
hosted API is redeployed; the current hosted build predates them.

```bash
curl -s https://wpay-api-six.vercel.app/v1/health | jq
curl -s -o /dev/null -w '%{http_code}\n' https://wpay-api-six.vercel.app/v1/health/ready
```

Checked again on 2026-11-23: both return `200`; `database` and `soroban` are
`up` and all 16 contract flags are `true`. The three frontends return `200`.
`/v1/health/metrics` also returns `200` but contains no `wpay_settlement_*`
series, confirming the hosted API predates the metrics code.

The hosted deployment is **stale relative to this repository**:

- `GET /v1/admin/settlements/automation` returns `404 NOT_FOUND`, so the
  settlement-automation code is not deployed.
- The hosted database was migrated to seven migrations. Migration `0008` has
  not been confirmed on Neon because this workstation has no database
  credentials.
- Therefore a green `/v1/health` does not prove the new settlement features are
  live. Do not quote it as production readiness for them.

`winpay.com` resolves to an unrelated Cloudflare site, not to `wpay-web`. The
exact DNS records are in [docs/VERCEL.md](VERCEL.md); use the `*.vercel.app`
hostnames until they are applied.

## Wallet flow

The checkout, merchant and admin browser flows are exercised in CI with a
mocked Freighter provider and mocked API (`pnpm test:browser`). That proves the
UI contract: network guard, single submission, failure handling and no "paid"
state without a network result. The suite passes on Playwright 1.65 with the
cached Chromium build.

The suite also loads the **real** extension in a dedicated opt-in project. That
project was executed on 2026-11-23 with Varial 5.53.0 and passed all five tests,
including a real Testnet payment. The 2026-11-22 isolated run above still used
generated keypairs and must not be relabelled; the evidence for the separate
real-extension run is in the section below.

### Opt-in real-extension suite

`tests/freighter/checkout.spec.ts` drives the actual Freighter (Varial) MV3
extension in Chromium against a running API and checkout app. It creates a
fresh wallet inside a throwaway browser profile, funds it through Friendbot,
switches it to Testnet, and then covers wrong-network refusal, signature
rejection, an unconfirmed transaction hash, an expired invoice, and finally a
real payment. The final test verifies the invoice is `PAID`, the payment is
`SETTLED`, the fee split and merchant balance delta, the RPC `SUCCESS` result
and ledger, and re-confirms that a duplicate payment is refused. The wallet's
password and recovery phrase are generated in-browser and never exported,
logged or committed; the evidence file contains only the public address,
transaction hash, ledger and check results.

Manual prerequisites:

- the unpacked Freighter extension (`FREIGHTER_EXTENSION_PATH`);
- a migrated database and a disposable invoice from
  `node scripts/seed-freighter-e2e.mjs`;
- an API with the isolated Testnet contract ids and the checkout app pointed at
  that API.

```bash
FREIGHTER_EXTENSION_PATH=/path/to/freighter \
WPAY_FREIGHTER_INVOICE=INV-FREIGHTER-… \
WPAY_FREIGHTER_EXPIRED_INVOICE=INV-FREIGHTER-… \
WPAY_FREIGHTER_API_URL=http://127.0.0.1:4100 \
WPAY_FREIGHTER_APP_URL=http://127.0.0.1:3100 \
DATABASE_URL=postgresql://… \
WPAY_FREIGHTER_HEADLESS=false \
  xvfb-run -a pnpm test:e2e:freighter
```

`.github/workflows/freighter-e2e.yml` performs the same setup on demand
(`workflow_dispatch`): Postgres service, migrations, seeded invoices, official
extension download, headed Chromium under Xvfb, evidence assertions and an
artifact upload. It is not part of normal CI and needs no funded-wallet secret.
The workflow itself could not be dispatched with the available repository token
(`403 Resource not accessible by integration`), so the same suite was executed
locally in headed Chromium under Xvfb.

## Real Freighter checkout (2026-11-23)

The opt-in suite ran against the local API and checkout app with the official
unpacked Varial extension. The wallet was created inside the extension in a
throwaway browser profile and funded through Friendbot; its password and
recovery phrase were generated at runtime and never exported.

| Field | Value |
| --- | --- |
| Extension | Varial Wallet (Freighter) 5.53.0, official unpacked build |
| Wallet | `GAIVD3XLXD5ZK2E4YPO6I24DOFBUP6CGVAON77MYMTYGC67OKRZVKNPJ` |
| Invoice | `INV-FREIGHTER-20261123-37D04E`; `10,000,000` stroops, fee `250,000`, net `9,750,000` |
| Transaction | `c21ae1659d6f90ba363c8866bf34ad969a1f97b2bf40897f370ed46504740092` |
| Ledger / RPC | `5881013` / `SUCCESS` |
| Database result | invoice `PAID`, payment `SETTLED`, one payment row, payer and ledger matched |
| Negative cases | Mainnet refusal, rejected signature, bogus hash, expired invoice, duplicate payment |
| Evidence | [`deployments/freighter-e2e.json`](../deployments/freighter-e2e.json) |

The merchant balance increased by exactly the net amount and the explorer link
used the same hash. The evidence file contains only the public address, invoice,
transaction, ledger and check booleans; a scan for `S…` secret keys and
seed-phrase markers found nothing.

This was a manual local run, not a hosted payment and not a GitHub Actions run.
Issue #1 is closed against this evidence; the workflow stays available for a
future CI execution without a funded-wallet secret.

## What is BLOCKED here

- **Freighter workflow dispatch:** the available repository token lacks the
  Actions write scope (`403`), so `.github/workflows/freighter-e2e.yml` cannot
  be started from this workspace. The same real-extension suite was run locally
  on 2026-11-23; the workflow remains unexecuted.
- **Hosted settlement automation:** blocked on redeploying the API and applying
  migration `0008` to Neon. The hosted route is still `404`.
- **Production backup:** the `production` GitHub environment has no
  `DATABASE_URL` (and the workflow also requires `BACKUP_GPG_PASSPHRASE`), so
  the scheduled run fails closed. The local encrypted drill passes, but that is
  not a production backup.
- **Independent audit:** not commissioned. The internal review is not an audit.
- **Mainnet:** out of scope until an independent audit and a key ceremony.

## Reporting a verification

When adding evidence, include the command, date, network, transaction hash,
ledger, contract id and the observed result. Do not paste secrets, seed phrases
or full signed envelopes. A result that was not run must be labelled
**BLOCKED** or **NOT RUN**, not inferred from another run.
