# Roadmap

Status legend: done / partial / not started. Nothing here is a promise of a date.

## Now — correctness and honesty

- [x] 16 contracts with tests and WASM builds
- [x] API, SDK, indexer, three web apps, mobile PWA, extension
- [x] Database schema, migration, seed
- [x] Infrastructure manifests, Helm, monitoring, CI, security scans
- [x] Documentation and honest deployment status
- [ ] Link contract-assigned refund ids to API records so approval can build a real transaction
- [ ] Shared (Redis) rate limiting and challenge storage for multi-replica API
- [ ] Webhook SSRF protection (allowlist + private IP blocking)
- [ ] DB-backed API integration tests against ephemeral Postgres
- [ ] Playwright browser E2E for checkout and dashboards

## Next — before mainnet

- [ ] Independent security audit of contracts and API
- [ ] Testnet deployment with published, verified contract ids
- [ ] Multisig/timelock for admin roles; documented key ceremony
- [ ] Fuzz/invariant testing for fee math, refunds and escrow transitions
- [ ] Settlement worker with idempotent batch execution and reconciliation report
- [ ] Code-splitting for the mobile bundle
- [ ] Backup restore and incident drills with recorded timings

## Later

- [ ] Wallet signing in mobile (WalletConnect or deep links) and extension
- [ ] Additional assets and path-payment support
- [ ] Multi-currency pricing via the oracle with staleness guarantees
- [ ] Merchant webhooks UI, replay controls and delivery analytics
- [ ] Localisation and accessibility audit
- [ ] Mainnet canary and staged merchant rollout

## Explicitly out of scope

- Custody of customer funds
- Fiat on/off-ramp
- Native mobile app stores (the PWA is the mobile client)
