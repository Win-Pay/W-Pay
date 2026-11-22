## Summary

<!-- What changed, and why. Link the issue if one exists. -->

## Risk

<!-- Money paths, authorization, migrations, event schema, deployment impact, or "none identified". -->

## Verification

<!-- Paste the commands you ran and their outcomes. Do not claim checks you did not run. -->

```bash
pnpm typecheck
pnpm test
pnpm lint
```

- [ ] Contract changes: `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build --target wasm32v1-none --release`
- [ ] Schema changes: migration included and tested against a database with existing data
- [ ] API route/config/event changes: docs updated (`docs/API.md`, `docs/ENVIRONMENT.md`, `docs/INDEXER.md`, `docs/SETTLEMENT.md` as applicable)
- [ ] New behavior has a regression test that fails before the change
- [ ] No secrets, private keys, real customer data or fabricated evidence are included
