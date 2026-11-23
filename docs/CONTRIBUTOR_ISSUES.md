# Contributor backlog

These are scoped tasks derived from the current code and known gaps. Items 1
and 2 below are completed and retained for context. Three genuine follow-up
tasks are filed remotely as issues
[#1](https://github.com/Win-Pay/W-Pay/issues/1),
[#2](https://github.com/Win-Pay/W-Pay/issues/2) and
[#3](https://github.com/Win-Pay/W-Pay/issues/3). Open a new issue with the
"Contributor task" template before starting substantial work so scope and
ownership are visible. Do not claim a task is complete without the listed
verification.

## 1. Test the settlement executor without a network

**Status: completed (2026-11-22).** `apps/api/src/settlement-executor.test.ts`
and the settlement service tests cover missing, partial, closed, executed and
malformed windows, wrong token/payee and terminal mismatches. The real path was
later also exercised on Testnet.

**Background.** `apps/api/src/settlement-executor.ts` parses `get_window`
results, computes missing entries, and submits `open`, `add_entry`, `close` and
`execute`. Only the orchestration around the executor is tested; parsing and
resume logic are not.

**Scope.** Add a narrow seam so the executor can be tested against a fake
Soroban gateway. Cover: missing window, open window with partial entries,
closed window, executed window, malformed/missing fields, wrong token/payee and
non-retryable mismatch. Do not change the contract or the RPC protocol.

**Acceptance.** Tests fail if a missing entry is duplicated, if an executed
window is submitted again, or if a malformed on-chain response is treated as
success. No test requires Testnet or a real signer.

**Testing.** `pnpm --filter @wpay/api test`, `pnpm typecheck`, `pnpm lint`.

**Likely files.** `apps/api/src/settlement-executor.ts`,
`apps/api/src/settlement.service.ts`, a new
`apps/api/src/settlement-executor.test.ts`.

## 2. Add a supervised Testnet settlement drill

**Status: completed (2026-11-22).** `scripts/e2e-invoice-testnet.cjs` deploys an
isolated suite, pays an invoice and runs settlement windows; the API maintenance
run created and executed window `4`. Evidence is in
`deployments/testnet-invoice-automation.json` and
[TESTNET_VERIFICATION.md](TESTNET_VERIFICATION.md). It is opt-in and never prints
secrets. A remaining follow-up is to make the API-side run a single portable
script rather than a documented manual sequence.

**Background.** Automatic settlement was originally tested only with a fake
executor. The repository now has an opt-in Testnet proof, recorded above.

**Scope.** Add a script that refuses any network other than Testnet, requires a
funded operator and explicit confirmation, creates a small batch, opens/adds/
closes/executes it, waits for the indexer/API to observe the events, and writes
sanitized evidence. It must never print secrets and must not run in normal CI.

**Acceptance.** On Testnet it produces a window id and transaction hashes that
can be checked in an explorer; `GET /v1/admin/settlements/reconciliation`
reports the window as executed. A missing pool or role fails with a clear error.
The README/report records the run only after it actually happens.

**Testing.** `node scripts/<script> --help`; one supervised Testnet run; no
mainnet path.

**Likely files.** `scripts/e2e-testnet.cjs`, `packages/sdk`, `docs/SETTLEMENT.md`.

## 3. Expose settlement automation metrics

**Status: implemented 2026-11-23 (local).** `apps/api/src/metrics.ts` renders the
backlog, retry-reason, run, duration, reconciliation and worker gauges at
`GET /v1/health/metrics`; unit tests in `metrics.test.ts` and Postgres
integration assertions cover it. Documentation and alerts are updated. The
remote issue is closed against the merged code and green CI; the hosted API
still needs the redeploy tracked in Issue #2 before the new series appear in
production.

**Background.** Health and `/metrics` show indexer state, but an operator cannot
alert on a growing backlog of due payments, failed automatic batches, or a
stuck batch.

**Scope.** Add gauges/counters for eligible unpaid claims, batches awaiting
retry, oldest unexecuted batch age, and last automation outcome. Keep labels
bounded; do not include merchant ids or addresses.

**Acceptance.** Metrics are present in `/v1/health/metrics`, covered by a test,
and documented. No cardinally unbounded label is introduced.

**Testing.** `pnpm --filter @wpay/api test`, scrape the endpoint, `pnpm lint`.

**Likely files.** `apps/api/src/modules/platform.ts`, health/metrics service,
`docs/DEPLOYMENT.md`.

## 4. Harden the backup workflow with an encryption check

**Background.** The backup workflow supports `BACKUP_GPG_PASSPHRASE`, but the
restore-drill job's encryption path is not asserted to produce ciphertext or to
reject a wrong passphrase.

**Scope.** In the restore-drill or verify job, assert that a passphrase backup
is non-plaintext, that the checksum matches, that a wrong passphrase fails, and
that a corrupted artifact fails checksum validation. Do not add production
secrets; use an ephemeral passphrase.

**Acceptance.** The job fails if the dump is left unencrypted, if checksum
verification is skipped, or if decryption with the wrong passphrase succeeds.

**Testing.** `bash -n scripts/*.sh`; run `.github/workflows/backup.yml` by manual
dispatch on a throwaway database.

**Likely files.** `.github/workflows/backup.yml`, `scripts/db-backup.sh`,
`scripts/db-restore-drill.sh`.

## 5. Build a real Freighter browser test harness

**Background.** All nine Playwright tests mock the provider and API. Real
extension connect/sign/reject behavior is untested.

**Scope.** Prototype a repeatable harness using a pinned extension build and a
funded Testnet account, marked manual/nightly and skipped by default. Cover
connect, wrong network, user rejection and a successful payment. Do not put a
seed phrase in the repository or ordinary CI logs.

**Acceptance.** The harness runs only with explicit credentials, fails clearly
when the extension/network is wrong, and produces a public Testnet transaction
hash for the success path. It does not weaken the existing mocked tests.

**Testing.** Manual/nightly run; `pnpm test:browser` remains green without
credentials.

**Likely files.** `tests/browser`, `playwright.config.*`, `docs/TESTING.md`.

## 6. Add invariant tests for contract fee arithmetic

**Background.** Fee math is covered by examples and checked arithmetic, but not
by property/invariant tests. A regression in rounding or the fee cap could pass
the current suite.

**Scope.** Add property tests around fee calculation and split conservation:
zero and maximum amounts, fee at/below/above the cap, rounding boundaries, and
`merchant + treasury == amount`. Keep tests inside the Soroban test host.

**Acceptance.** A deliberately broken rounding or cap change makes the new tests
fail. Existing 140 contract tests remain green.

**Testing.** `cargo test --manifest-path packages/contracts/Cargo.toml`,
`cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`.

**Likely files.** `packages/contracts/contracts/payment-router/src/lib.rs`,
`packages/contracts/contracts/wpay-common/src/lib.rs`.

## Owner-only actions (not contributor tasks)

These require credentials or external state and must not be simulated by a
contributor:

- Apply migration `0008_settlement_automation` to the hosted Neon database and
  redeploy the API before using the new endpoints.
- Configure the GitHub `DATABASE_URL` repository secret (and optionally
  `BACKUP_GPG_PASSPHRASE`) so backups stop failing closed.
- Run a supervised Testnet settlement batch and record the evidence.
- Commission an independent audit and move admin keys to multisig/hardware
  wallets before mainnet.
