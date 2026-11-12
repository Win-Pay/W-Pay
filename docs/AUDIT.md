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
including two resource benchmarks), TypeScript tests (194 passed, 2 skipped),
three Playwright checkout tests with a mocked wallet, build/typecheck of every
package, Prisma schema validation, API coverage (89.45% statements), a real
Testnet deployment and payment, a Testnet RPC/Horizon resource measurement,
`cargo audit`, and static checks configured in CI (CodeQL, Trivy, gitleaks,
dependency review). Locally executed: Gitleaks (no leaks), `pnpm
audit --prod` (no known production advisories), Helm lint/template, kubeconform,
Prometheus/Alertmanager config checks, and Docker image build. No fuzzing,
formal verification, external penetration test, or mainnet test was performed.

## Findings

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

4. **Rate limiting across replicas — fixed when Redis is configured.**
   `RedisRateLimitStore` is used when `REDIS_URL` is set; otherwise the API
   logs a warning and falls back to per-process counters. Deployments must set
   `REDIS_URL` or enforce limits at the ingress.
5. **Wallet challenge store — fixed.** Challenges are persisted in the
   `WalletNonce` table with expiry and single-use deletion, so any replica can
   verify them.
6. **Refund execution linkage — fixed for indexed refunds.** The indexer links
   `requested` refund events to the record; approval then builds the contract
   call. If the refund is not linked, or already on chain, the API returns
   `409` instead of pretending to submit.
7. **JWT storage in `localStorage`.** XSS would expose tokens. Consider httpOnly
   cookies with CSRF protection. Helmet is enabled and React escapes by default,
   but this remains a residual risk.
8. **Broad extension host permission (`https://*/*`).** Narrow to your API host
   in production builds.
9. **Real browser wallet flow untested.** The checkout now has three Playwright
   tests with a mocked Freighter provider and mocked API, covering missing
   wallet, single submission and failed submission. The real extension, user
   rejection and real Testnet signing are still not exercised by CI.
10. **Settlement execution is budget-bounded.** A 50-entry
    `settlement.execute` exceeded the local Soroban test-host budget in
    `auth.rs`; the API caps batches at 20 entries. The 20-entry benchmark uses
    ~4.2M CPU instructions and carries a large rent component. Re-check the cap
    against current network limits before raising it.

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
16. **Dashboard browser coverage is missing.** The Playwright suite covers checkout only; admin and merchant dashboard flows are not browser-tested.
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
  in health/metrics/admin endpoints and never silently dropped. Encrypted
  database backups and their restore path were verified locally.
- Settlement batches are operator-created, require unique payees, reject
  duplicate windows, verify a linked on-chain window's token/period, and cannot
  be cancelled after execution.
- `prisma validate` passes and the baseline migration matches the schema.
- `pnpm audit --prod --audit-level=high` reports no known production
  vulnerabilities after the zod 4 upgrade and transitive overrides.
- `cargo audit` reports one transitive advisory (RUSTSEC-2026-0387) with no
  compatible fixed release in the current Soroban SDK; it is ignored explicitly
  in CI rather than hidden.
- Contract WASM hashes match the 16 deployed Testnet contracts (16/16).
- Kubernetes manifests pass kubeconform; Helm lint/template pass; Prometheus and
  Alertmanager configurations validate.

## Conclusion

The codebase is a coherent, tested foundation with a verified Testnet
deployment. It is **not production-ready for real funds**: the centralized admin
key model and the absence of an independent audit remain prerequisites. The
Testnet deployer is a throwaway key. Nothing in this repository should be read
as evidence of a mainnet deployment or an external audit.
