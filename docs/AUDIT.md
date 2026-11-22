# Engineering audit

This is an internal, self-review of the code in this repository. It is **not**
an independent security audit and must not be described as one.

## Scope reviewed

- 16 Soroban contracts and `wpay-common`
- API auth, payments, refunds, webhooks, admin actions
- Indexer event handling
- SDK transaction building and wallet adapters
- Infrastructure manifests and CI workflows

## Method

Manual review of entry points and state transitions, `cargo test` (140 tests,
including two resource benchmarks), TypeScript tests (263 passed, 2 skipped),
nine Playwright tests with mocked wallets/API (re-run green on 2026-11-22),
build/typecheck/lint of every package, Prisma schema validation, API coverage
(88.25% statements, 71.87% branches, 91.36% functions), a real 16-contract
Testnet deployment and payment, a Testnet RPC/Horizon resource measurement,
`cargo audit`, and static checks configured in CI (CodeQL, Trivy, gitleaks,
dependency review plus a push/schedule production dependency audit). Locally
executed: Gitleaks (no leaks), `pnpm audit --prod` (no known production
advisories), Helm lint/template, kubeconform, Prometheus/Alertmanager config
checks, Docker image builds and health smokes, and an encrypted backup/restore
drill (AES-256, checksum, 21 public tables, all eight migrations). On
2026-11-22 an isolated five-contract Testnet deployment additionally executed a
real invoice payment, two settlement windows and an automatic settlement window
through the API worker, with contract events and balance deltas verified. No
fuzzing, formal verification, external penetration test, or mainnet test was
performed. The CI additions (clippy `-D warnings`, the resource benchmarks,
Prisma/Compose/shell validation, dependency audit) passed in CI run 45067193267
on commit `b9bdba4` (2026-11-22).

## Findings

### Closed in this review

- **Merchant fee evasion and ownership spoofing — fixed.** A non-staff user could
  previously pick `feeBps` (including `0`) when creating their own merchant, and
  could register an `ownerAddress` that did not belong to the authenticated
  wallet. `MerchantsService.create` now requires the owner address to equal the
  account's verified `stellarAddress` and forces the platform rate (250 bps) for
  every non-staff caller. `PATCH /merchants/:id` still cannot change the fee.
  Regression coverage lives in the real-Postgres integration suite.
- **Refresh-token theft detection — fixed.** Refresh tokens are opaque, stored
  as SHA-256 hashes, rotated on every use and grouped into a family. Replaying a
  rotated token revokes the whole family and returns `401`; logout and
  logout-all revoke explicitly. Verified against a real Postgres/Redis API run.
- **Invoice verification bound to the memo — fixed.** Confirming an invoice
  payment now checks that the contract invocation memo equals the invoice
  number, in addition to amount, recipient, payer and the emitted event. The
  historical Testnet confirmation used an `e2e-invoice` memo and therefore no
  longer satisfies invoice-level verification (it remains valid evidence that
  the payment settled on-chain).
- **Frontend localhost fallback — fixed.** Production builds without
  `NEXT_PUBLIC_API_URL` render a visible configuration error instead of calling
  a localhost API. The previously hard-coded defaults were removed from all
  three Vercel apps.
- **Wallet login replay — fixed.** SEP-53 challenges are single-use rows in
  `WalletNonce` with expiry, so a captured signature cannot be replayed and any
  replica can verify it.
- **Persisted credentials — removed.** Access and CSRF tokens live in memory
  only. The rotating refresh token is an `HttpOnly`, `Secure` cookie scoped to
  `/v1/auth`, rotated on use with a single-flight guard, and refresh/logout
  require a matching `x-csrf-token`. State-changing requests from an unlisted
  browser `Origin` are rejected.
- **Extension host access — narrowed.** The manifest requests origin access only
  when a lookup is performed, instead of `https://*/*` at install time.
- **Browser hardening — added.** Production builds serve CSP,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy` and a restrictive `Permissions-Policy`.

### High / needs action before production

1. **Webhook SSRF — fixed.** `apps/api/src/webhooks/url-guard.ts` resolves the
   host, rejects private/reserved IPv4 and IPv6 ranges (including mapped and
   embedded IPv4), blocks local hostnames and credentials in URLs, and blocks
   redirects. It runs at registration and again at delivery; regression tests
   cover both paths. `WEBHOOK_ALLOW_PRIVATE_TARGETS=1` is the deliberate local
   test escape hatch.
2. **Admin keys are centralized.** A single admin key can change fees up to the
   cap, pause, and propose upgrades. Use multisig/hardware wallets and a
   timelock; the upgrade manager's delay must be configured explicitly. The
   Testnet deployer is a throwaway single key and must not be reused. A concrete
   2-of-3 account design and ceremony checklist are in
   [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md); none of it has been executed.
3. **Unaudited contracts handling funds.** No independent audit exists. Do not
   deploy to mainnet with real value without one.

### Medium

4. **Rate limiting across replicas — fixed.** `RedisRateLimitStore` is used when
   `REDIS_URL` is set, and production refuses to boot without it unless
   `ALLOW_IN_MEMORY_RATE_LIMIT=1` is explicitly set. `trust proxy` defaults to
   one hop in production so counters key on the client, not the ingress.
5. **Wallet challenge store — fixed.** Challenges are persisted in the
   `WalletNonce` table with expiry and single-use deletion, so any replica can
   verify them.
6. **Refund execution linkage — fixed for indexed refunds.** The indexer links
   `requested` refund events to the record. Approval records the decision and
   returns `transaction: null` while the refund is unlinked, rather than
   pretending to submit; `POST /v1/refunds/:id/approve-transaction` then
   returns the contract call once linked (`409 REFUND_NOT_LINKED` before
   that).
7. **Session storage — mitigated.** Access and CSRF tokens live in memory only.
   The rotating refresh token is an `HttpOnly`, `Secure` cookie scoped to
   `/v1/auth` and is not readable by JavaScript; refresh and logout require a
   matching `x-csrf-token`, tokens are rotated and reuse revokes the whole
   family. `SameSite` defaults to `None` for cross-site frontends and can be
   `Lax` with a first-party `COOKIE_DOMAIN`; cross-site refresh still depends on
   browser third-party-cookie policy, so a first-party cookie domain is
   preferred. Helmet and CSP remain defence in depth.
8. **Extension host permission — fixed.** The MV3 manifest no longer requests
   `https://*/*`; it uses `optional_host_permissions` and asks for the single
   configured API origin when the user performs a lookup.
9. **Real browser wallet flow untested.** Nine Playwright tests cover checkout,
   fee disclosure, receipt/Explorer link, failed submission, landing page,
   merchant dashboard and admin dashboard with a mocked Freighter provider and
   mocked API. The suite passed on 2026-11-22. The real extension, user
   rejection and real Testnet signing are still not exercised by CI. The
   2026-11-22 Testnet invoice run used generated keypairs through the SDK.
10. **Settlement execution is budget-bounded.** A 50-entry
    `settlement.execute` exceeded the local Soroban test-host budget in
    `auth.rs`; the API caps batches at 20 entries. The 20-entry benchmark uses
    ~4.2M CPU instructions and carries a large rent component. Re-check the cap
    against current network limits before raising it.
10a. **Automatic settlement introduces a hot operator key.** `execute` mode signs
    with `SOROBAN_SOURCE_SECRET` from process env; there is no HSM or multisig.
    The contract role limits what the key can do, but a stolen operator key can
    still open and execute windows up to the pool balance, bypassing API limits.
    The worker was exercised on Testnet on 2026-11-22 with a low-value test key
    and executed window `4` successfully. Keep automation `off`/`prepare` in
    production until a dedicated low-balance key, external signer/HSM and
    contract-level pause procedures are in place. The control is implemented
    and exercised; it is not independently audited.

### Low / informational

11. **Container hardening untested at runtime.** The images build and the API
    container passes a health smoke test as the non-root `node` user;
    read-only root filesystems are set in Kubernetes but not exercised here.
    Next.js may need a writable `.next/cache`.
12. **`SOROBAN_SOURCE_SECRET` in process env.** Prefer a signer service or HSM for
    any automated flow.
13. **Metrics and health are public.** They expose component status and counts;
    ensure no sensitive numbers are added.
14. **Deployment files use placeholder hosts** (`example`, `wpay.example`); they
    are templates and will not route real traffic.
15. **Mobile bundle is large** (~1.27 MB, Stellar SDK). Code-splitting would help;
    not a security issue.
16. **Dashboard browser coverage is mocked.** Nine Playwright tests cover
    checkout, merchant dashboard and admin dashboard, but all mock the wallet
    and API; no real backend or Freighter extension is exercised.
17. **Rust advisory (transitive).** `cargo audit` reports RUSTSEC-2026-0387
    (timing variability in `crypto-bigint` 0.5.5), reached through
    `soroban-env-host` 29.0.1 → `elliptic-curve` 0.13. The patched 0.7.x line is
    not compatible with the current SDK, so CI pins an explicit ignore and the
    advisory is re-checked on every SDK bump. It affects host-side cryptographic
    operations, not contract logic authored here, but it is not currently
    fixable without an upstream update.

## Verified properties

- Every state-changing contract function checks authorization and pause state in
  tests; refunds authorize the settlement address.
- Fee arithmetic uses checked math and returns errors rather than trapping;
  the cap is enforced in two places.
- API keys are stored hashed; plaintext is returned only at creation.
- Merchant fee and owner address are server-enforced: self-service creation
  rejects a wallet mismatch and ignores client-supplied `feeBps`.
- Refresh-token rotation, family revocation on reuse and logout are covered by
  tests and were exercised against a running API with real Postgres/Redis.
- Webhook signatures are constant-time compared with a timestamp window.
- API and frontends never report a payment settled without an on-chain result.
  Verified against Testnet: a bogus hash and a mismatched amount were rejected
  and the invoice stayed `OPEN`.
- No secrets are committed; `.env.example` contains placeholders only and
  Gitleaks found no leaks in the tracked history.
- Production CORS uses only `WEB_PUBLIC_URL` plus explicit `CORS_ORIGINS`;
  localhost is added only outside production.
- `/v1/health/ready` returns `503` unless Postgres and the Soroban RPC both
  answer; storage/Redis dependency failures propagate instead of being reported
  as ready.
- Indexer projection failures are durable (`IndexerFailure`), retried, surfaced
  in health/metrics/admin endpoints and never silently dropped. Replay is
  bounded, resets a durable checkpoint, and is idempotent; the consistency
  report checks stale checkpoints, failures and projection invariants.
- Backups are custom-format dumps; the workflow verify job validates them with
  `pg_restore --list` (the local drill skipped this because `pg_restore` is not
  installed and used the Docker fallback). They carry a SHA-256 sidecar and
  support GPG public-key or AES-256 passphrase encryption; retention pruning only
  matches WPay artifacts. The restore drill compares all tables and applied
  migrations. A clean encrypted round-trip on 2026-11-22 matched all 21 public
  tables and eight migrations; the production workflow has not run because
  `DATABASE_URL` is missing.
- Settlement batches are operator-created, require unique payees, reject
  duplicate windows, verify a linked on-chain window's token/period, and cannot
  be cancelled after execution.
- Automatic settlement claims eligible payments atomically (no double
  assignment), respects the hold and refunds, bounds each run, backs off on
  failure, avoids retrying non-retryable mismatches, releases cancelled windows,
  and exposes reconciliation totals. It was tested against Postgres with a fake
  executor and, on 2026-11-22, executed a real Testnet window (`4`) through the
  API worker with four `SUCCESS` transactions; a stable second pass created no
  duplicate payment or batch. See
  [TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md).
- `prisma validate` passes; the schema is represented by eight ordered
  migrations. Migration `0008` was validated locally through the real Prisma
  runner and `prisma migrate diff`, but it is not yet applied to the hosted
  database and the hosted API still returns `404` for the automation route.
- `pnpm audit --prod --audit-level=high` reports no known production
  vulnerabilities after the zod 4 upgrade and transitive overrides.
- `cargo audit` reports one transitive advisory (RUSTSEC-2026-0387) with no
  compatible fixed release in the current Soroban SDK; it is ignored explicitly
  in CI rather than hidden.
- Contract WASM hashes match the 16 deployed Testnet contracts (16/16).
- Kubernetes manifests pass kubeconform; Helm lint/template pass; Prometheus and
  Alertmanager configurations validate.

## Independent Soroban audit package

**Status: package prepared; no auditor has been engaged and no independent audit
report exists.** This section is the hand-off material for a professional
review. Nothing here may be quoted as an audit result.

### Scope and artifacts

- Source: this repository at commit `b9bdba4` (or the commit that adds this
  section). Contract workspace: `packages/contracts`.
- Contracts in scope: 16 Soroban contracts plus `wpay-common`. The original
  Testnet deployment ids, upload/create transactions and WASM hashes are in
  [DEPLOYMENTS.md](../DEPLOYMENTS.md). The isolated five-contract invoice and
  settlement deployment is in
  [TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md).
- Toolchain: Rust 1.100.0, `wasm32v1-none`, Soroban SDK 29.0.1, pinned
  `Cargo.lock`. `pnpm contracts:build` reproduces the WASM artifacts; hashes are
  compared against the deployment records.
- Off-chain scope for a full review: NestJS API, indexer, Prisma schema and
  migrations, TypeScript SDK, wallet adapters, Docker/Kubernetes manifests and
  the three Next.js apps.
- Out of scope: Stellar core, Soroban host, the Stellar Asset Contract
  implementation, wallet extension internals, Vercel/Neon/Upstash infrastructure.

### Architecture

Contracts are independent Soroban instances with shared `wpay-common` helpers
for role checks, pause state, token transfers and validation. The payment path
is `MerchantRegistry` membership → `PaymentRouter.create_payment` → fee split
from `FeeManager` → token transfers to treasury and merchant. `InvoiceManager`
creates invoices and calls the router on payment. `SettlementManager` holds
pooled funds and executes operator-created windows. Escrow, refunds,
subscriptions, treasury, governance, pause, roles, upgrades, configuration,
price oracle and achievements are separate contracts. The API builds and
verifies transactions; the indexer projects contract events into Postgres. The
contracts are the authority for on-chain balances; the database is a
projection plus off-chain business records.

### Privileged entry points

Every state-changing entry point calls `require_auth` and, where applicable,
`access::require_role` and `pause::require_not_paused`. The table below is the
review checklist; function names link to the source in
`packages/contracts/contracts/<name>/src/lib.rs`.

| Contract | Privileged / sensitive entry points | Authorization |
| --- | --- | --- |
| `role-manager` | `initialize`, `grant_role`, `revoke_role`, `transfer_admin` | first admin once; Admin role; self-revoke blocked |
| `fee-manager` | `initialize`, `set_default_fee`, `set_merchant_fee` | Admin; fee cap enforced |
| `merchant-registry` | `register`, `approve`, `suspend`, `reactivate`, `close`, `update_settlement`, `set_fee_bps`, `set_pause_authority`, `set_paused` | owner/Admin/Operator/merchant as documented |
| `payment-router` | `create_payment`, `record_refund`, `set_treasury`, `set_registry`, `set_fee_manager`, pause setters | payer; refund manager; Admin |
| `invoice-manager` | `create`, `pay`, `cancel`, `mark_expired`, `set_router`, `set_registry`, pause setters | merchant owner; payer; Admin/Operator |
| `settlement-manager` | `open_window`, `add_entry`, `close_window`, `fund`, `execute`, `cancel`, pause setters | Operator/Admin; payee and token validation |
| `treasury-vault` | `deposit`, `withdraw`, `schedule_withdrawal`, `execute_withdrawal`, `cancel_withdrawal`, `set_threshold`, pause setters | Admin; large withdrawals pass a fixed timelock |
| `emergency-pause` | `register_target`, `unregister_target`, `pause_all`, `unpause_all`, `pause_target`, `unpause_target` | Pauser/Admin; each target must recognize the authority |
| `upgrade-manager` | `propose`, `execute`, `upgrade_self`, `cancel` | Admin; delay bounded to 1 hour–30 days |
| `governance` | `add_member`, `remove_member`, `propose`, `vote`, `finalize`, `mark_executed`, `cancel` | Admin/member; quorum and voting period |
| `configuration-manager` | `set` | Admin |
| `price-oracle` | `set_price`, `set_max_age` | Admin/Oracle; freshness enforced on reads |
| `impact-nft` | `mint`, `revoke` | Admin/Issuer |
| `escrow-manager`, `refund-manager`, `subscription-manager` | lifecycle, dispute, resolve, approve/reject, charge/cancel, pause setters | role- and party-specific checks |

Important limitation: only `UpgradeManager` has a
`update_current_contract_wasm` call, and it only upgrades itself. The other
contracts have no in-contract upgrade entry point, so their deployed WASM is
effectively immutable. `UpgradeManager` records an authorized hash for other
targets but does not apply it; an operator would need a separate, audited
mechanism. Do not describe this as a complete upgrade system.

### Multisig, hardware wallets and timelocks

- Contracts authorize Stellar `Address` values. A Stellar account configured
  with multiple signers and thresholds can satisfy `require_auth`, so account
  multisig is compatible at the protocol level.
- **No multisig account, hardware wallet, or key ceremony has been configured
  or verified.** The recorded Testnet deployer/admin is a single throwaway key.
- The treasury vault enforces a fixed timelock for large withdrawals;
  `UpgradeManager` enforces a configurable delay within fixed bounds. Neither is
  a substitute for an external timelock on every admin action.
- The governance contract implements member proposals and voting, but it is not
  wired into the other contracts' authorization checks in this repository.
  Treat cross-contract governance as unimplemented until an integration test and
  deployment evidence exist.

### Trust assumptions

1. Stellar Testnet/Mainnet consensus and the SAC token contracts behave as
   specified; W-Pay does not reimplement token accounting.
2. Admin, operator, pauser, oracle and settlement keys are honest and held
   securely. The current model is single-key; compromise can pause, change fees
   within the cap, approve merchants, move treasury funds under the timelock, or
   execute settlement windows up to the funded pool.
3. The configured treasury and merchant settlement addresses are correct.
   On-chain payments are irreversible.
4. Soroban RPC and Horizon can delay, omit or lie about results. The API
   cross-checks transaction results and the indexer replays events, but a
   compromised RPC can cause temporary denial or lag. There is no multi-provider
   quorum in this repository.
5. Off-chain user and merchant records are not recoverable from chain alone;
   their integrity depends on database backups and access control.
6. The indexer's event decoder matches the deployed contract event schema. The
   contracts still use the deprecated tuple `Events::publish` API in SDK 29;
   schema changes must be rolled out with the decoder.
7. Price oracle values are trusted for any flow that consumes them; stale
   prices are rejected by `fresh_price`.

### Test and evidence package

- `pnpm contracts:test`: 140 Rust tests across 18 suites, including two
  resource benchmarks and authorization/pause regression tests.
- `pnpm contracts:build`: 16 WASM artifacts; hashes match the deployed Testnet
  contracts. The isolated five-contract run also matched.
- Testnet: 16-contract deployment and one historical payment; isolated invoice
  `2` payment (`22f24058…37dd`), two manual settlement windows, and automatic
  settlement window `4` (`921f5836…4319`) with four `SUCCESS` transactions.
  Duplicate payment, non-owner creation, unsupported token and expired invoice
  were rejected. Full hashes, ledgers, events and balance deltas are in
  [TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md).
- Indexer: live-event catch-up, checkpoints, four expected dead letters reviewed
  and resolved, and a stable pass with no duplicate payment or batch.
- TypeScript: 263 passed, 2 skipped; nine Playwright tests with mocked wallet and
  API. No real Freighter extension test.
- Migration `0008`: validated locally through Prisma on PostgreSQL 16, with
  data-preservation, FK, nullability, unique-index and drift checks; not applied
  to the hosted database.
- Backup: encrypted local restore drill matched 21 public tables and eight
  migrations; no production backup exists.
- CI: run 45067193267 (CI) and 45067193233 (Security) are green on `b9bdba4`.
- Dependency audit: no known production advisories (`pnpm audit`); one
  transitive Rust advisory, RUSTSEC-2026-0387, with no compatible fix in the
  current Soroban SDK (see finding 17).

### Known risks and questions for the auditor

1. **Single-key administration.** Highest priority. Review the key ceremony,
   role separation, pause response and treasury timelock assumptions.
2. **Settlement pool accounting.** Verify that `open_window`/`add_entry`/
   `close_window`/`fund`/`execute` cannot overpay, double-pay, or strand funds;
   review token and recipient validation, duplicate-window handling and the
   20-entry budget cap.
3. **Invoice ↔ router linkage.** Verify amount, payer, merchant, fee and event
   binding, and that the API's memo-based confirmation cannot be spoofed.
4. **Refund/escrow/subscription state machines.** Review authority boundaries,
   reentrancy assumptions, and partial-failure behavior.
5. **Pause fan-out.** `EmergencyPause` invokes every target; verify failure
   handling, target caps and authority wiring.
6. **Upgrade path.** Confirm the limited self-upgrade scope and design a real
   multi-contract upgrade mechanism before mainnet.
7. **Event schema and indexer trust.** Review deprecated events, cursor replay,
   dead-letter resolution and duplicate protection.
8. **Off-chain API authorization.** Review merchant scoping, RBAC, CSRF/refresh
   rotation, rate limiting, webhook SSRF guard and admin audit logging.
9. **Operational readiness.** Hosted migration 0008, API redeploy, production
   backup, PITR, RPC failover and real-wallet E2E are not yet verified.
10. **Dependency advisories.** Confirm the RUSTSEC-2026-0387 risk and the
    upstream fix plan.

### Remediation backlog before mainnet

- Independent audit of all 16 contracts and the settlement/invoice changes;
  remediate and re-audit.
- Multisig or hardware-backed admin/operator keys, documented ceremony, and
  separated roles; external timelock for treasury/admin actions.
- Apply migration `0008` to the hosted database, redeploy the API, and verify
  the settlement routes against Neon.
- Complete a successful production backup + verify + restore-drill workflow run
  and configure PITR/off-site encrypted storage.
- Real Freighter checkout E2E on Testnet with a funded user wallet, including
  rejection and wrong-network cases.
- Resident indexer/webhook workers or a queue, with RPC failover and load tests.
- Fuzzing/invariant testing for settlement, refund and escrow arithmetic.
- A documented event-schema migration off deprecated `Events::publish`.
- Move `SOROBAN_SOURCE_SECRET` to an external signer/HSM and test the emergency
  pause and key-rotation runbooks.

## Conclusion

The codebase is a coherent, tested foundation with a verified Testnet
deployment and a real invoice/settlement/automation run. It is **not
production-ready for real funds**: the centralized admin key model, the absence
of an independent audit, the undeployed migration/API, the missing production
backup, and the untested real-wallet flow remain prerequisites. The Testnet
deployer is a throwaway key. Nothing in this repository should be read as
evidence of a mainnet deployment or an external audit. The section above is an
audit hand-off package, not an audit report.
