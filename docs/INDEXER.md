# Indexer

The indexer (`apps/indexer`) turns Soroban contract events into the Postgres
read model used by the API and dashboards. Money stays on-chain; the database is
a projection that can be rebuilt by replaying events.

## Runtime

```
INDEXER_START_LEDGER   first ledger to read when no checkpoint exists (default 1)
INDEXER_BATCH_SIZE     events requested per contract per tick (default 100)
INDEXER_INTERVAL_MS    poll interval (default 5000)
INDEXER_PORT           health/metrics HTTP port (default 4100)
CONTRACT_*_ID          one id per contract; unset contracts are skipped
STELLAR_RPC_URL        overrides the network default
```

`main.ts` runs one pass immediately, then ticks on the interval. A tick that
overlaps a previous one is skipped. `/health` reports `ok` or `degraded`, the
last run time, the last error and the number of unresolved projections;
`/metrics` exposes `wpay_indexer_last_run_timestamp_seconds` and
`wpay_indexer_unresolved_failures`. Operators use:

| Route | Role | Purpose |
| --- | --- | --- |
| `GET /v1/admin/indexer/status` | `OPERATOR` | Checkpoints, last run and health |
| `GET /v1/admin/indexer/failures` | `OPERATOR` | Unresolved and resolved dead letters |
| `POST /v1/admin/indexer/failures/:id/resolve` | `OPERATOR` | Mark a reviewed failure resolved (audit-logged) |
| `POST /v1/admin/indexer/replay` | `ADMIN` | Reset a contract checkpoint and replay bounded pages (audit-logged) |
| `GET /v1/admin/indexer/consistency` | `OPERATOR` | Cross-check checkpoints, failures and projection invariants |

## Ingestion algorithm

For each configured contract (`Indexer.ingestContract`):

1. Read the `IndexerCheckpoint` for the contract id (`lastLedger` plus the
   RPC `cursor`). The ledger fallback is
   `max(checkpoint.lastLedger, INDEXER_START_LEDGER)`.
2. If the checkpoint has a cursor, call `getEvents({ cursor, filters, limit })`
   so the pass resumes exactly where the previous page ended, including the
   middle of a ledger. If the RPC rejects the cursor (provider retention window
   expired), log it and fall back to
   `getEvents({ startLedger: lastLedger + 1, filters, limit })`; duplicates are
   absorbed by the unique event index. Without a cursor, start at `startLedger`
   and request `endLedger = startLedger + 5`, because some RPC providers return
   no events for an exact single-ledger range.
3. For each event: decode topics/value, plan a projection, then in **one
   Postgres transaction** insert `IndexedEvent` and apply the projection.
4. A duplicate `(contractId, txHash, eventIndex)` raises Prisma `P2002`; the
   transaction rolls back and the event is counted as `skipped`. A crash can
   therefore never persist an event without its projection (or vice versa).
5. Persist the new cursor and ledger. A non-full batch checkpoints at
   `latestLedger`; a full batch keeps the last processed ledger so events in the
   same ledger are not skipped. The checkpoint is only upserted when one of the
   two values changed.

## Event decoding and projections

`decode.ts` maps contract topics to kinds for `PaymentRouter`,
`RefundManager`, `EscrowManager`, `InvoiceManager`, `SubscriptionManager`,
`SettlementManager` and `MerchantRegistry`. `indexer.ts` applies:

| Event | Effect |
| --- | --- |
| `payment` | Settle the matching `Payment`, set contract id/ledger/fee/net, mark linked invoice PAID |
| `refund_requested` / `refund_approved` / `refund_rejected` | Link the contract refund id and update status |
| `refund` | Update refunded amount/status (`PARTIALLY_REFUNDED`/`REFUNDED`) |
| `escrow_created` / escrow status | Link contract escrow id, move `CREATED` → `FUNDED` → final status |
| `invoice_created` / `invoice_paid` / invoice status | Link contract invoice id, mark paid, link payment |
| `plan_created` / plan status | Link `planIdOnChain`, toggle active |
| `subscription_created` / `charged` / `cancelled` | Link contract sub id, advance cycles/prepaid/next due, cancel |
| `settlement_opened` / `closed` / `executed` / `cancelled` | Link and advance settlement window |
| merchant registered/status/settlement | Link `registryId`, update status/settlement address |

### Terminal-state protection

Retries and out-of-order replays must not move a record backwards. Projections
apply conditional updates from an allowed source state and treat a terminal
record as already applied:

- refunded amounts are monotonic; a stale `refund` event cannot lower `refunded`.
- refund decisions apply only while `PENDING`; a later stale request/approval
  cannot reopen an `APPROVED` or `REJECTED` refund.
- invoices move to `PAID`/`CANCELLED`/`EXPIRED` only from `OPEN`.
- escrows and subscriptions advance from their current state; a replayed
  `created`/`charged` event is a no-op.
- settlement windows only move forward (`OPEN → CLOSED → EXECUTED`,
  `OPEN|CLOSED → CANCELLED`).
- merchant status applies from an allowed source state
  (`PENDING|ACTIVE|SUSPENDED → CLOSED`, `ACTIVE → SUSPENDED`, etc.).

The integration suite includes a replay test that applies a stale event after a
terminal projection and asserts the terminal state is unchanged.

### Linking heuristics

API-created records do not know the contract id until an event arrives. The
indexer therefore matches a single unambiguous candidate:

- payments: unique PENDING payment with the same amount and payer (and merchant
  when the event carries the registry id);
- refunds/invoices/plans/escrows/settlements: unique record with matching
  amount (or period/token for settlements) and no contract id yet.

If zero or more than one candidate exists, the projection is skipped and the
event remains recorded (`applied=false`) with an `IndexerFailure` row. This is
intentional: the indexer never guesses which invoice a payment belongs to.
Operators can reconcile from the `IndexedEvent` payload or the failure row. A
settled payment is never re-pointed at another transaction, and a contract id
already linked to a different row is rejected.

## Failures, retries and dead letters

- Malformed events (`kind=unknown` or an undecodable value) and projection
  planning errors are persisted with the event and record an `IndexerFailure`
  that has no stored projection; they require a decoder/data fix.
- An ambiguous projection stores the planned projection JSON. Each `runOnce()`
  first calls `retryFailures(50)`, which re-applies stored projections in a
  transaction. A successful retry sets `resolvedAt`; a failed retry increments
  `attempts` and keeps the row for the next tick.
- Later successful application of the same event resolves any prior failure.
- `IndexerFailure` is unique on `(contractId, eventIndex)`, so replays do not
  multiply rows. Unresolved failures turn the health check to `degraded` and are
  visible through metrics and the admin endpoints; they are never silently
  dropped. Integration tests cover retry recovery and persistent ambiguity.

## Replay and recovery

- The checkpoint is per contract in `IndexerCheckpoint` and stores both the last
  ledger and the RPC cursor. `Indexer.resetCheckpoint(contract, fromLedger)`
  upserts `lastLedger` and clears the cursor, forcing ledger mode.
- `Indexer.replay(contract, { fromLedger, maxPages })` resets the checkpoint and
  calls `ingestContract` until a partial page or the page cap (default 10,
  hard cap 100; the admin route caps the request at 50). The RPC request stays
  bounded so the HTTP endpoint fits inside a serverless timeout; call it again
  to continue from the advanced cursor.
  `done` is true only after a final partial page. Inserts are idempotent and
  projections converge on event state.
- `POST /v1/admin/indexer/replay` exposes the same operation:
  ```bash
  curl -s "$API/v1/admin/indexer/replay" -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"contract":"PaymentRouter","fromLedger":123456,"maxPages":10}' | jq
  ```
  The route validates that the contract is configured, is audit-logged, and
  returns `pages`, `fetched`, `inserted`, `skipped`, `applied`, `failed`,
  `lastLedger` and `done`. Do not reset a checkpoint without a ledger that
  actually covers the incident; replay is not a substitute for a backup.
- The database can be rebuilt from a backup and a replay plus off-chain records
  (users, merchant profiles, invoices) that do not exist on-chain.

## Consistency checks

`Indexer.consistency(staleAfterMinutes = 30)` produces a read-only report at
`GET /v1/admin/indexer/consistency`: event counts by kind and ledger range,
configured contracts with checkpoint/staleness, unresolved failures and maximum
attempts, plus projection invariants:

| Counter | Meaning |
| --- | --- |
| `settledWithoutContractLink` | A settled payment has no `txHash` or `contractPaymentId` |
| `paidInvoicesWithoutPayment` | A `PAID` invoice has no linked payment |
| `executedWindowsWithoutTx` | An `EXECUTED` settlement window has no transaction hash |
| `unknownEvents` | Events decoded as `kind=unknown` (decoder gap or new contract event) |

`ok` is true only when every configured contract has a fresh checkpoint, there
are no unresolved failures, and all invariant counters are zero. A nonzero
counter is an investigation trigger, not proof of lost funds; inspect the event
or failure row before editing data.

## Reconciliation

`Indexer.reconcile(merchantId)` compares:
indexed `payment` events, settled payments, payments linked to a contract id,
and pending payments. Use it after a replay or when investigating a mismatch
between chain balances and dashboard totals.

## Limitations

- Polling, not streaming; latency is bounded by `INDEXER_INTERVAL_MS`.
- The RPC range workaround (`endLedger = startLedger + 5`) can re-fetch events
  that are deduplicated by the unique index; it does not lose them. An expired
  cursor does the same when falling back to the recorded ledger.
- Event schemas are decoded by topic order. A contract event shape change
  requires updating `decode.ts` and tests.
- Ambiguous projections are skipped rather than guessed; they need operator
  reconciliation or a later retry once the matching local record exists.
- Malformed events and projection-planning errors are dead-lettered and only
  clear after a code/data fix; retrying them does not change their outcome.
