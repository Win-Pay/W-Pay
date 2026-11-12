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

Manual review of entry points and state transitions, `cargo test` (138 tests),
TypeScript tests (38), build/typecheck of every package, Prisma schema
validation, and static checks configured in CI (CodeQL, Trivy, gitleaks,
dependency review). No fuzzing, formal verification, penetration test, or
live-network test was performed.

## Findings

### High / needs action before production

1. **Webhook delivery can reach internal addresses (SSRF).** Merchant-provided
   URLs are fetched by the API worker without private-IP/host allowlisting.
   Mitigate with an egress allowlist, DNS re-resolution checks, and blocking
   `169.254.0.0/16`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`.
2. **Admin keys are centralized.** A single admin key can change fees up to the
   cap, pause, and propose upgrades. Use multisig/hardware wallets and a
   timelock; the upgrade manager's delay must be configured explicitly.
3. **Unaudited contracts handling funds.** No independent audit exists. Do not
   deploy to mainnet with real value without one.

### Medium

4. **Rate limiting is per process.** With N replicas the effective limit is N×.
   Move to a shared store (e.g. Redis) or enforce at the ingress.
5. **Wallet challenge store is process-local.** Multi-replica deployments can
   fail verification if the challenge is issued by one pod and verified by
   another; use a shared store or sticky routing. Confirm single-use semantics
   under concurrency.
6. **Refund execution linkage is incomplete.** The API records approval, but
   building the on-chain refund transaction requires the contract-assigned
   refund id from the indexer. Until linked, approval is a record, not a
   transaction. This is documented rather than faked.
7. **JWT storage in `localStorage`.** XSS would expose tokens. Consider httpOnly
   cookies with CSRF protection. Helmet is enabled and React escapes by default,
   but this remains a residual risk.
8. **Broad extension host permission (`https://*/*`).** Narrow to your API host
   in production builds.

### Low / informational

9. **Container hardening untested.** Read-only root filesystems are set for the
   API/indexer; Next.js may need writable `.next/cache`. Validate at deploy time.
10. **`SOROBAN_SOURCE_SECRET` in process env.** Prefer a signer service or HSM for
    any automated flow.
11. **Metrics and health are public.** They expose component status and counts;
    ensure no sensitive numbers are added.
12. **Deployment files use placeholder hosts** (`example`, `wpay.example`); they
    are templates and will not route real traffic.
13. **Mobile bundle is large** (~1.27 MB, Stellar SDK). Code-splitting would help;
    not a security issue.
14. **No E2E browser tests**, so UI regressions are not caught by CI.

## Verified properties

- Every state-changing contract function checks authorization and pause state in
  tests; refunds authorize the settlement address.
- Fee arithmetic uses checked math and returns errors rather than trapping;
  the cap is enforced in two places.
- API keys are stored hashed; plaintext is returned only at creation.
- Webhook signatures are constant-time compared with a timestamp window.
- API and frontends never report a payment settled without an on-chain result.
- No secrets are committed; `.env.example` contains placeholders only.
- `prisma validate` passes and the baseline migration matches the schema.

## Conclusion

The codebase is a coherent, tested foundation, but it is **not production-ready
for real funds**. The three high findings plus an independent audit are
prerequisites. Nothing in this repository should be read as evidence of a
deployed or audited system.
