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
including two resource benchmarks), TypeScript tests (209 passed, 2 skipped),
five Playwright tests with a mocked wallet, build/typecheck of every package,
Prisma schema validation, API coverage (89.4% statements), a real Testnet
deployment and payment, a Testnet RPC/Horizon resource measurement,
`cargo audit`, and static checks configured in CI (CodeQL, Trivy, gitleaks,
dependency review). Locally executed: Gitleaks (no leaks), `pnpm
audit --prod` (no known production advisories), Helm lint/template, kubeconform,
Prometheus/Alertmanager config checks, and Docker image build. No fuzzing,
formal verification, external penetration test, or mainnet test was performed.

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
   `requested` refund events to the record; approval then builds the contract
   call. If the refund is not linked, or already on chain, the API returns
   `409` instead of pretending to submit.
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
9. **Real browser wallet flow untested.** Five Playwright tests cover checkout,
   fee disclosure, receipt/Explorer link, failed submission and the landing
   page with a mocked Freighter provider and mocked API. The real extension,
   user rejection and real Testnet signing are still not exercised by CI.
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
