# Contracts

All contracts live in `packages/contracts/contracts/` and share
`packages/contracts/common` (`wpay-common`): types (`Payment`, `Merchant`,
`FeeSplit`, `Error`, `Role`), access control, pause guards, validation helpers,
token helpers and generated `#[contractclient]` traits for cross-contract calls.

Soroban SDK 29. Build target: `wasm32v1-none` (see `scripts/build-contracts.sh`).

## Inventory

| Contract | Responsibility |
| --- | --- |
| `role-manager` | Grants/revokes roles; admin bootstrap; prevents self-revocation |
| `configuration-manager` | Typed key/value config, validation boundaries, admin-only writes |
| `fee-manager` | Default and per-merchant fees in bps, cap enforcement, fee/treasury address |
| `merchant-registry` | Merchant lifecycle (pending → active → suspended → closed), settlement address, pause authority |
| `payment-router` | Creates payments, computes splits via fee manager, records refunds, emits events |
| `invoice-manager` | On-chain invoice records and paid/cancelled state |
| `escrow-manager` | Deposit, release, refund, dispute, resolve |
| `refund-manager` | Refund requests with merchant-settlement-address approval |
| `subscription-manager` | Plans and prepaid billing cycles |
| `settlement-manager` | Settlement batches and execution records |
| `treasury-vault` | Fee custody and authorized withdrawals |
| `emergency-pause` | Global/per-contract pause with authority or admin |
| `upgrade-manager` | Wasm hash proposals, delay, upgrade execution |
| `price-oracle` | Admin-published asset prices with staleness bounds |
| `governance` | Proposals, voting, execution threshold |
| `impact-nft` | Non-transferable impact receipts |

## State machines

**Merchant**: `PENDING → ACTIVE → SUSPENDED → ACTIVE`, and any non-closed state
→ `CLOSED` (terminal). Registration requires a non-empty name, a unique
merchant id, a valid settlement address and a fee at or below the cap.

**Payment**: `PENDING → SETTLED` or `PENDING → FAILED`, plus `REFUNDED`
(partial refunds tracked with a refunded amount). A payment can only be created
for an active merchant; refunds cannot exceed the gross or the remaining
refundable amount.

**Escrow**: `FUNDED → RELEASED` or `FUNDED → REFUNDED`; `FUNDED → DISPUTED →
RELEASED/REFUNDED`. Only the payer may open a dispute; the operator resolves it.

**Refund request**: `PENDING → APPROVED → EXECUTED` or `PENDING → REJECTED`.
Approval must be authorized by the merchant's **settlement address**, because
that address owns the funds. A registry-owner signature is not sufficient.

**Subscription**: `ACTIVE → CANCELLED`. Cycles are prepaid; recurring charges
cannot require a subscriber signature per cycle, so the balance is drawn from
prepaid cycles rather than allowance pulls.

## Fee math

`fee = floor(amount * bps / 10_000)`, `net = amount - fee`. The router rejects
any computed fee above the configured cap and any `fee > amount`. Zero amounts
cannot be split (error, not panic). Arithmetic uses checked operations so
overflow returns an error rather than trapping.

Examples verified in tests: 200 bps of 10,000 → 200 fee / 9,800 net; 250 bps of
10,000 → 250 / 9,750.

## Authorization and pause

- Every mutating entry point calls `require_auth()` on the acting address and
  checks the role through the role manager or the contract's admin slot.
- Pause checks run first; a paused contract returns `Error::Paused`.
- The emergency-pause contract can pause specific contracts or all of them;
  unpause requires the same authority.
- Admin grant/revoke events are emitted for auditability; an admin cannot revoke
  their own last admin role.

## Events

Events are emitted after state changes and are the indexer's only input. Topics
use `symbol_short!` (≤ 9 characters, e.g. `payment`, `refund`, `unpause`). Data
payloads contain ids, amounts, status discriminants and addresses — no secrets.

## Testing

- `cargo test` runs 138 tests across 18 binaries, including nested-auth refund
  flows, cross-contract registry/fee lookups, paused-contract rejection, overflow
  handling, and invalid state transitions.
- Snapshot tests record ledger/auth state for key scenarios under
  `test_snapshots/`.
- `packages/contracts/integration-tests` covers the full lifecycle across
  contracts.
- `mock_all_auths` does not satisfy nested auth for a non-root contract call;
  refund tests authorize explicitly with the settlement address.

## Deployment

There are **no** W-Pay deployments. Scripts build and (when you supply keys and a
network) deploy; nothing is deployed as part of CI. See
[DEPLOYMENTS.md](../DEPLOYMENTS.md) for the required verification steps and
what to publish after a real deployment.

## Known limitations

- Fee splitting happens inside `payment-router` and trusts the fee manager's
  configuration; a compromised fee manager admin can set fees up to the cap.
- `price-oracle` trusts its publisher; consumers must check staleness.
- Upgrade execution is delayed but not timelocked by governance in all paths.
- No formal verification and no external audit.
