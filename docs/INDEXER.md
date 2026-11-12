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
overlaps a previous one is skipped. `/health` reports `ok` or `degraded` plus the
last run time and error; `/metrics` exposes
`wpay_indexer_last_run_timestamp_seconds`.

## Ingestion algorithm

For each configured contract (`Indexer.ingestContract`):

1. Read the `IndexerCheckpoint` for the contract id. Start at
   `max(checkpoint, INDEXER_START_LEDGER)`.
2. `getEvents({ startLedger, filters: [{ type: "contract", contractIds }], limit })`.
   The API requests `endLedger = startLedger + 5` because some RPC providers
   return no events for an exact single-ledger range.
3. For each event: decode topics/value, plan a projection, then in **one
   Postgres transaction** insert `IndexedEvent` and apply the projection.
4. A duplicate `(contractId, txHash, eventIndex)` raises Prisma `P2002`; the
   transaction rolls back and the event is counted as `skipped`. A crash can
   therefore never persist an event without its projection (or vice versa).
5. If the batch was not full, checkpoint at `latestLedger`; otherwise at the
   last processed ledger so events in the same ledger are not skipped.

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

### Linking heuristics

API-created records do not know the contract id until an event arrives. The
indexer therefore matches a single unambiguous candidate:

- payments: unique PENDING payment with the same amount and payer (and merchant
  when the event carries the registry id);
- refunds/invoices/plans/escrows/settlements: unique record with matching
  amount (or period/token for settlements) and no contract id yet.

If zero or more than one candidate exists, the projection is skipped and the
event remains recorded (`applied=false`). This is intentional: the indexer never
guesses which invoice a payment belongs to. Operators can reconcile from the
`IndexedEvent` payload. A settled payment is never re-pointed at another
transaction, and a contract id already linked to a different row is rejected.

## Replay and recovery

- The checkpoint is per contract in `IndexerCheckpoint`.
- To replay, set `INDEXER_START_LEDGER` to a ledger before the incident and
  delete/reset the checkpoint row for the contract. Inserts are idempotent and
  projections are written to converge on the event state.
- The database can be rebuilt from a backup and a replay plus off-chain records
  (users, merchant profiles, invoices) that do not exist on-chain.

## Reconciliation

`Indexer.reconcile(merchantId)` compares:
indexed `payment` events, settled payments, payments linked to a contract id,
and pending payments. Use it after a replay or when investigating a mismatch
between chain balances and dashboard totals.

## Limitations

- Polling, not streaming; latency is bounded by `INDEXER_INTERVAL_MS`.
- The RPC range workaround (`endLedger = startLedger + 5`) can re-fetch events
  that are deduplicated by the unique index; it does not lose them.
- Event schemas are decoded by topic order. A contract event shape change
  requires updating `decode.ts` and tests.
- Ambiguous projections are skipped rather than guessed; they need operator
  reconciliation.
- No dead-letter queue: a permanently failing projection leaves the event
  recorded with `applied=false` and stops the batch at the error (transaction
  rolled back). Fix the data/decoder and replay.
