# Settlement and reconciliation

Settlement has two layers in W-Pay. They are related but not the same operation:

1. **Per-payment split.** `PaymentRouter` settles a payment on chain: the
   merchant's net amount goes to its settlement address and the platform fee
   goes to the treasury. This happens when the payer signs and the network
   accepts the payment transaction.
2. **Settlement windows.** `SettlementManager` executes a batched payout to
   multiple payees (up to 20 entries through the API, 50 in the contract) from
   funds the contract holds. An operator opens a window, adds entries, closes it,
   and executes it.

The database is a projection of both layers. It never represents a payout as
complete until the indexer observes the corresponding contract event.

## Contract state machine

`packages/contracts/contracts/settlement-manager/src/lib.rs`:

```text
open_window -> Open --add_entry--> Open --close_window--> Closed
                                        \--cancel--> Cancelled
Closed --execute--> Executed
```

| Transition | Authorization | Preconditions |
| --- | --- | --- |
| `open_window` | `Operator` role | `period_start < period_end` |
| `add_entry` | `Operator` role | Window is `Open`; positive amount; entry cap not reached |
| `close_window` | `Operator` role | Window is `Open`; at least one entry |
| `fund` | Any account (permissionless) | Positive amount; transfers into the contract pool |
| `execute` | `Operator` role | Window is `Closed`; contract not paused; pool covers the full window |
| `cancel` | `Admin` role | Window is not `Executed` |

Invariants enforced by the contract:

- Entries are immutable once the window is closed, so the payout list cannot
  change between closing and execution.
- A window is all-or-nothing. If the pool cannot cover the total, `execute`
  reverts instead of paying some merchants first.
- The pool is tracked per token and never pays more than it holds.
- `execute` is not idempotent by design. A second call fails because the window
  is already `Executed`; callers must check state before submitting.

## API workflow

The API builds unsigned Soroban transactions; an operator wallet signs and
submits them. `GET /v1/settlements` is available to merchants (scoped to their
own merchants) and to operators; every other route below requires the
`OPERATOR` role, except cancellation, which requires `ADMIN`.

| Step | Route | Notes |
| --- | --- | --- |
| 1. Create | `POST /v1/settlements/batches` | 1–20 entries; payees unique; positive amounts; an entry with `merchantId` must use that merchant's settlement address; duplicate `(token, period)` returns `409` |
| 2. Open | `POST /v1/settlements/:id/intents` | Returns the `open_window` intent while `windowIdOnChain` is null |
| 3. Link | `POST /v1/settlements/:id/link` | Records the on-chain window id if the indexer has not observed the open event yet; rejects reused ids |
| 4. Populate and close | `POST /v1/settlements/:id/intents` | Returns one `add_entry` intent per payee (sorted by address) followed by `close_window` |
| 5. Execute | `POST /v1/settlements/:id/execute-intent` | Allowed only when the local window is `CLOSED`; returns the `execute` intent |
| Cancel | `POST /v1/settlements/:id/cancel-intent` | Admin only; refused once the window is `EXECUTED` |

Read endpoints are `GET /v1/settlements` and `GET /v1/settlements/:id`. The list
is scoped to the caller's merchants unless the caller is `ADMIN` or `OPERATOR`.

Funding the pool is deliberately not an API route. Use `fundSettlementPool` from
`@wpay/sdk` or the Stellar CLI to call `SettlementManager.fund(from, token,
amount)`. Funding is permissionless; it cannot remove funds or change a window.

## Automatic settlement worker

`SettlementAutomationService` (`apps/api/src/settlement.service.ts`) closes the
manual-batching gap without weakening the operator intent flow. It is invoked by
`GET /v1/internal/maintenance` after the indexer pass, so the same cron/worker
that catches up events also prepares and executes due batches.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SETTLEMENT_AUTOMATION` | `off` | `off`, `prepare` (create batches only) or `execute` (also drive them on chain) |
| `SETTLEMENT_HOLD_HOURS` | `24` | Minimum age of a settled payment before it can be claimed |
| `SETTLEMENT_MAX_ENTRIES` | `20` | Payees per automatic batch (hard API/contract cap is 20/50) |
| `SETTLEMENT_MAX_STEPS` | `5` | Soroban transactions per batch per worker run |
| `SETTLEMENT_RETRY_MINUTES` | `30` | Base retry delay; doubles per failed attempt up to 24 hours |
| `SETTLEMENT_DELAY_ALERT_MINUTES` | `120` | Age after which an unexecuted batch raises an in-app alert |
| `SETTLEMENT_OPERATOR_ADDRESS` | derived from `SOROBAN_SOURCE_SECRET` | Operator account that must hold the Operator role |

`execute` mode refuses to boot without `SOROBAN_SOURCE_SECRET`; `prepare` and
`execute` both refuse to boot without an operator address. Production config
therefore fails closed instead of silently skipping payouts.

Safety properties:

- **Atomic claim.** Eligible payments (`SETTLED`, `PARTIALLY_REFUNDED`,
  `REFUNDED`, older than the hold, `net > 0`, not yet assigned) receive
  `settlementWindowId` and `settlementAmount` in the same transaction that
  creates the batch. A payment can never belong to two batches. A lost worker
  rolls back the batch instead of leaving a partial claim.
- **Refund-aware amounts.** The claimed amount is `net - refunded` at claim
  time. Later refunds are reported by reconciliation rather than rewriting
  settlement history.
- **Bounded and resumable.** `SorobanSettlementExecutor` reads the contract
  window before every mutation, adds only missing entries, closes and executes
  within `SETTLEMENT_MAX_STEPS` transactions. A crash between transactions
  resumes from on-chain state; it cannot duplicate an entry or a payout.
- **No guessing.** A token, payee, amount, or status mismatch between the local
  batch and the contract window is a non-retryable failure that requires an
  operator.
- **Backoff and alerts.** Failures store `lastError`, increment `attempts`,
  schedule exponential `nextAttemptAt`, and create one notification per batch.
  An operator can clear the backoff with `POST /v1/admin/settlements/:id/retry`.
- **Cancellation release.** Payments in a `CANCELLED` window are released and
  become eligible for a later batch.

Automation routes:

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /v1/admin/settlements/run` | `OPERATOR` | Run prepare; body `{"execute":true}` requires `ADMIN` and execute mode |
| `GET /v1/admin/settlements/automation` | `OPERATOR` | Recent automatic batches, attempts, errors and next retry |
| `GET /v1/admin/settlements/reconciliation` | `OPERATOR` (scoped for merchants) | Payable/allocated totals, treasury fees, window status and invariant counters |
| `POST /v1/admin/settlements/:id/retry` | `ADMIN` | Clear a batch's backoff after investigation |

The manual operator flow above remains available and is still required when
automation is `off`, when a batch is non-retryably blocked, or when an operator
wants to re-check the intent before signing. Automatic execution signs with the
dedicated operator key; it never holds merchant funds and `SettlementManager`
still enforces the role, pause and pool checks.

## Indexer projection

`SettlementManager` events are applied by `apps/indexer/src/indexer.ts`:

| Event | Projection |
| --- | --- |
| `open` | Link a matching unlinked local window (same token and period) to `windowIdOnChain`; an already linked window is only checked for a matching token/period |
| `close` | `OPEN → CLOSED`, store the on-chain total |
| `execute` | `CLOSED → EXECUTED`, set `executedAt` |
| `cancel` | `OPEN|CLOSED → CANCELLED` |

The indexer does **not** project individual `entry` events. Entries are created by
the API when the batch is created, so a window populated directly on chain
without the API will show an empty entry list even though its status and total
are projected. Create batches through the API when the database must mirror the
payout list.

Projections are guarded so a replayed or out-of-order event cannot move a
terminal window backwards. A stale `closed` event cannot reopen or re-close an
`EXECUTED` window, and a stale `open` event cannot overwrite a terminal state.
The same guard exists for payments, refunds, escrows, invoices, subscriptions
and merchant status. See [INDEXER.md](INDEXER.md#failures-retries-and-dead-letters).

## Reconciliation runbook

Use this when a dashboard total, a contract balance, or a window status disagrees
with the chain.

1. **Inspect the local window**
   ```bash
   curl -s "$API/v1/settlements/<id>" -H "Authorization: Bearer $TOKEN" | jq
   ```
   Compare `status`, `windowIdOnChain`, and entry totals with the contract.
2. **Read the contract window**
   ```bash
   stellar contract invoke --id "$CONTRACT_SETTLEMENT_MANAGER_ID" \
     --network testnet -- get_window --id <windowId>
   ```
3. **Check indexer health**
   ```bash
   curl -s "$API/v1/health" | jq '.indexer'
   curl -s "$API/v1/admin/indexer/status" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
   curl -s "$API/v1/admin/indexer/failures" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
   ```
   `status: "stale"` means no checkpoint has advanced for 30 minutes. Unresolved
   failures include the stored projection and the contract/tx/index tuple.
4. **Replay if needed.** Use `POST /v1/admin/indexer/replay` as an `ADMIN`
   with `{"contract":"SettlementManager","fromLedger":<ledger>}`. The endpoint
   resets the checkpoint, replays bounded pages, and re-applies idempotent
   projections; terminal states do not regress. This avoids manual database
   edits and is audit-logged. See [INDEXER.md](INDEXER.md#replay-and-recovery).
   `GET /v1/admin/indexer/consistency` reports stale checkpoints, unresolved
   failures, unknown event kinds, settled payments without a contract link,
   paid invoices without a payment, and executed windows without a transaction.
5. **Resolve or escalate failures.** `POST /v1/admin/indexer/failures/:id/resolve`
   marks a reviewed failure as resolved and is audit-logged. Do not resolve a
   failure merely to clear the count; record why the projection cannot apply.
6. **Inspect automation state.** `GET /v1/admin/settlements/automation` shows
   automatic batches, attempts, last error and next retry. `attempts` with no
   progress after backoff indicates a persistent problem, not a transient one.
7. **Confirm the pool before execution.** `execute` reverts when the pool is
   short. Check `SettlementManager.pool(token)` against the window total before
   asking an operator to sign.

## Metrics

`GET /v1/health/metrics` exposes the existing payment/invoice/refund/merchant
gauges plus settlement automation metrics. Every label is a bounded enum
(`status`, `outcome`, `reason`, `check`, `mode`); wallet addresses, merchant
names, memos, transaction hashes and raw error text are never used as labels.
The settlement values are derived from Postgres at scrape time, so they are
consistent across serverless instances and survive cold starts.

| Metric | Type | Meaning |
| --- | --- | --- |
| `wpay_settlement_eligible_payments` | gauge | Settled payments with unallocated net above zero after the hold period |
| `wpay_settlement_pending_windows{status="OPEN\|CLOSED"}` | gauge | Automatic batches still awaiting execution |
| `wpay_settlement_oldest_pending_age_seconds` | gauge | Age of the oldest pending automatic batch |
| `wpay_settlement_automation_runs_total{outcome="success\|failure"}` | gauge | Executed automatic batches, and batches currently in backoff |
| `wpay_settlement_retries_total{reason=…}` | gauge | Failed attempts grouped by bounded reason (`insufficient_pool`, `rpc_unavailable`, `state_mismatch`, `budget_exceeded`, `cancelled`, `other`) |
| `wpay_settlement_last_success_timestamp_seconds` | gauge | Last executed automatic batch (`0` when none) |
| `wpay_settlement_execution_duration_seconds` | summary | Creation-to-execution duration for the last 500 executed batches |
| `wpay_settlement_reconciliation_failures{check=…}` | gauge | Executed window without a tx, paid invoice without a payment, settled payment without a contract link, plus `total` |
| `wpay_settlement_automation_enabled{mode="off\|prepare\|execute"}` | gauge | Configured automation mode |
| `wpay_settlement_worker_up` | gauge | `0` only when automation is deliberately off |
| `wpay_api_indexer_checkpoint_age_seconds` / `_up` | gauge | API-side indexer freshness (never gates readiness) |
| `wpay_api_indexer_unresolved_failures` / `_checkpoints` | gauge | Durable dead letters and checkpoint count |

The indexer keeps its own `wpay_indexer_last_run_timestamp_seconds` and
`wpay_indexer_unresolved_failures` metrics; the API-side names are prefixed
with `wpay_api_` so both series can be scraped without collisions.

Alert rules in `monitoring/alerts.yml` cover a two-hour pending batch, batches
in backoff for 30 minutes, and any reconciliation inconsistency for 15 minutes.
The Grafana dashboard `monitoring/grafana-dashboard.json` has panels for the
backlog, age, failure reasons, run outcomes and p95 execution duration.

```bash
curl -s "$API/v1/health/metrics" | grep wpay_settlement_
```

`wpay_settlement_last_success_timestamp_seconds` staying at `0` while batches
exist means automation has never completed a batch; check the mode, the executor
key and `/v1/admin/settlements/automation`.

## What is verified

- Contract state transitions and authorization are covered by Rust unit tests;
  the full `cargo test` suite (140 tests, including the resource benchmarks) and
  the WASM build passed locally on rustc 1.100.0 (2026-11-22). Live Testnet
  execution is still not verified.
- API creation, linking, intent construction and authorization are covered by
  the Postgres integration suite (`apps/api/src/postgres.integration.test.ts`).
- Automatic claiming, refund aggregation, hold exclusion, success, failure
  backoff, non-retryable handling, cancellation release and reconciliation
  totals are covered by `apps/api/src/settlement.integration.test.ts` against
  Postgres, using a fake `SettlementExecutor`. This verifies orchestration and
  database concurrency, not a live Soroban signature.
- Indexer projection, terminal-state protection, checkpoint replay and the
  consistency report are covered by
  `apps/indexer/src/indexer.integration.test.ts`.
- The merchant dashboard lists settlement batches from the API
  (`apps/merchant-dashboard`), covered by a mocked browser test.

## What is not verified

- No settlement window has been executed against Testnet in this repository's
  recorded evidence. The recorded end-to-end payment covers `PaymentRouter`
  settlement, not a batched `SettlementManager.execute`, and the automated test
  executor is a fake rather than a Testnet signer.
- `SorobanSettlementExecutor`'s RPC parsing and transaction submission are not
  covered by an integration test; they require Testnet credentials and a funded
  operator/pool. Production automation therefore remains unproven until the
  owner runs one supervised batch on Testnet.
- Automatic notifications are in-app rows; no email or pager delivery is wired.
- No load or resource test has been run for a 20-entry `execute` on the live
  network. The local test-host measurement is in
  [TESTING.md](TESTING.md#soroban-resource-measurements); network cost may differ.
