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

### Why there is no automatic payout worker

The API exposes intents, not signing keys. Automatic execution would require a
custodial settlement signer and a scheduler, neither of which is enabled. The
roadmap item remains open. Any statement that batches execute "automatically"
would be false; execution is an explicit operator action.

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
4. **Replay if needed.** Stop the indexer, set `INDEXER_START_LEDGER` before the
   affected ledger, clear the contract's checkpoint cursor, and restart. Inserts
   are idempotent and terminal projections do not regress. See
   [INDEXER.md](INDEXER.md#replay-and-recovery).
5. **Resolve or escalate failures.** `POST /v1/admin/indexer/failures/:id/resolve`
   marks a reviewed failure as resolved and is audit-logged. Do not resolve a
   failure merely to clear the count; record why the projection cannot apply.
6. **Confirm the pool before execution.** `execute` reverts when the pool is
   short. Check `SettlementManager.pool(token)` against the window total before
   asking an operator to sign.

## What is verified

- Contract state transitions and authorization are covered by Rust unit tests
  (`cargo test`, when the Rust toolchain is available).
- API creation, linking, intent construction and authorization are covered by
  the Postgres integration suite (`apps/api/src/postgres.integration.test.ts`).
- Indexer projection and terminal-state protection are covered by
  `apps/indexer/src/indexer.integration.test.ts`.
- The merchant dashboard lists settlement batches from the API
  (`apps/merchant-dashboard`), covered by a mocked browser test.

## What is not verified

- No settlement window has been executed against Testnet in this repository's
  recorded evidence. The recorded end-to-end payment covers `PaymentRouter`
  settlement, not a batched `SettlementManager.execute`.
- There is no scheduled settlement worker and no automatic reconciliation job;
  the runbook above is manual.
- No load or resource test has been run for a 20-entry `execute` on the live
  network. The local test-host measurement is in
  [TESTING.md](TESTING.md#soroban-resource-measurements); network cost may differ.
