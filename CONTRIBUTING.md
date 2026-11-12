# Contributing

## Setup

See [docs/INSTALL.md](docs/INSTALL.md). Required before a pull request:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm contracts:test
pnpm contracts:build
cargo fmt --all --manifest-path packages/contracts/Cargo.toml -- --check
```

Describe in the PR what you ran; do not claim checks you did not run.

## Rules

- **No fabricated state.** Never mark something deployed, tested or audited
  unless it is. Placeholders are better than invented ids or results.
- **Money paths need tests.** Changes to fee math, refund authorization, payment
  state transitions or settlement require unit tests, and contract changes
  require a test that fails before the fix.
- **No panics in contracts** for user-reachable input; return `Error`.
- **Authorization first.** Every new entry point must call `require_auth()` and
  check the appropriate role; add a negative test.
- **Never commit secrets.** Use `.env` locally; CI uses repository secrets.
- **Keep the dependency surface small.** New dependencies need a reason and a
  licence compatible with MIT.
- TypeScript is strict; avoid `any` and non-null assertions in new code.
- Amounts are `i128` decimal strings; never use JavaScript numbers for money.

## Style

- Conventional commit subjects (`fix(api): …`, `feat(contracts): …`), imperative
  mood.
- One logical change per PR; keep generated files (`dist/`, `target/`) out.
- Update docs when behaviour, configuration or endpoints change.

## Contract changes

Contract changes are high risk. Include:

1. the invariant being preserved or changed;
2. the storage/migration impact (Soroban storage is not automatically migrated);
3. the event changes and indexer impact;
4. an upgrade plan (wasm hash, delay, rollback).

## Review

Two approvals are required for contract, payment-flow and infrastructure
changes. Security-relevant changes should reference the threat model.
