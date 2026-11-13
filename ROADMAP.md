# Roadmap

Status legend: done / partial / not started. Nothing here is a promise of a date.

## Now — correctness and honesty

- [x] 16 contracts with tests and WASM builds
- [x] API, SDK, indexer, three web apps, mobile PWA, extension
- [x] Database schema, migration, seed
- [x] Infrastructure manifests, Helm, monitoring, CI, security scans
- [x] Documentation and honest deployment status
- [x] Link contract-assigned refund ids to API records so approval can build a real transaction
- [x] Rebuild the refund approval transaction after the link appears (`POST /v1/refunds/:id/approve-transaction`)
- [x] Shared (Redis) rate limiting with an explicit in-process fallback
- [x] Webhook SSRF protection (DNS resolution + private/reserved address blocking)
- [x] DB-backed API integration tests against Postgres
- [x] Testnet deployment with published, verified contract ids and transactions
- [x] End-to-end Testnet payment verified on-chain and through the API
- [x] k6 load test wired into CI with latency and error thresholds
- [x] Automated PostgreSQL backup workflow, executable restore drill, encrypted off-site copy support and measured local restore
- [x] Playwright checkout tests with a mocked wallet and mocked API (real-extension E2E remains open)
- [ ] Playwright browser E2E for merchant/admin dashboards

## Next — before mainnet

- [ ] Independent security audit of contracts and API
- [ ] Mainnet deployment after audit; replace the throwaway Testnet deployer key
- [ ] Multisig/timelock for admin roles; documented key ceremony
- [ ] Fuzz/invariant testing for fee math, refunds and escrow transitions
- [ ] Settlement worker with idempotent automatic batch execution and reconciliation report (operator-driven batch API and intents exist; automatic payout is deliberately not enabled)
- [ ] Code-splitting for the mobile bundle
- [x] Hosted API and Postgres (Vercel/Neon) with webhook and indexer catch-up via the Vercel cron plus a 15-minute GitHub Actions job
- [ ] Real-time worker host attached to the hosted database (Compose or Kubernetes), plus dashboards
- [ ] Incident drill with recorded timings (backup restore is automated)

## Later

- [ ] Wallet signing in mobile (WalletConnect or deep links) and extension
- [ ] Additional assets and path-payment support
- [ ] Multi-currency pricing via the oracle with staleness guarantees
- [ ] Merchant webhooks UI and delivery analytics (API retry/requeue exists)
- [ ] Localisation and accessibility audit
- [ ] Mainnet canary and staged merchant rollout

## Explicitly out of scope

- Custody of customer funds
- Fiat on/off-ramp
- Native mobile app stores (the PWA is the mobile client)
