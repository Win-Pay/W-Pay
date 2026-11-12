# Threat model

## Assets

1. Customer and merchant funds held by contracts.
2. Settlement and treasury addresses.
3. Admin/operator keys and API credentials.
4. Off-chain records (invoices, merchants, webhook secrets) whose corruption
   misleads users even if funds are safe.
5. Availability of payment creation and confirmation.

## Actors

- **Customer** — pays, may be malicious, controls their own key.
- **Merchant** — receives funds, configures settlement/webhooks, may attempt
  refund abuse.
- **Operator/admin** — approves merchants, resolves disputes, can pause.
- **Indexer/API** — untrusted infrastructure from the chain's perspective.
- **External attacker** — no credentials; may spam, phish or exploit SSRF.
- **Compromised dependency** — supply-chain attacker.

## Threats and mitigations

| Threat | Impact | Mitigation | Status |
| --- | --- | --- | --- |
| Forged payment confirmation | Merchant ships goods unpaid | `confirm` verifies the transaction result on-chain; indexer reconciles from events | Implemented; not exercised on a live network |
| Replay of signed transaction | Double spend | Stellar sequence numbers + contract idempotency per payment id | Implemented |
| Unauthorized refund | Funds drained to attacker | Refund approval requires merchant settlement address; amount capped at gross | Implemented + tested |
| Fee manipulation | Merchant overcharged | Fee cap enforced in fee manager and router; admin-only writes; events emitted | Implemented + tested |
| Malicious merchant registration | Impersonation | Operator approval required before activation | Implemented |
| Pause abuse | Denial of service | Pause requires authority/admin; unpause event logged | Implemented |
| API key leak | Scoped data/payment access | Hashed at rest, prefix lookup, scopes, revocable | Implemented |
| JWT theft via XSS | Account takeover | Short expiry; CSP/helmet; no tokens in URLs | Partially mitigated; tokens in localStorage |
| Webhook SSRF | Internal network access | Merchant-supplied URLs fetched by worker | **Not mitigated** — add allowlist/private-IP blocking before production |
| Webhook forgery | Fake payment events | HMAC-SHA256 over timestamp + body, constant-time compare | Implemented |
| Challenge replay | Session hijack | Single-use, expiring challenge bound to domain | Implemented; store is process-local |
| Rate-limit bypass | DoS/brute force | Per-IP limiter | In-process only — bypassable across replicas |
| Indexer poisoning | False state | Only contract events for configured ids are accepted; upserts idempotent | Implemented |
| Supply chain | Backdoor | Lockfile, pnpm build allow-list, CodeQL, Trivy, gitleaks, dependency review | Configured in CI |
| Admin key compromise | Full control | Recommend multisig, delayed upgrade, pause | Process control, not code |
| Malicious upgrade | Contract takeover | Upgrade manager requires proposal + delay + authority | Implemented; delay values must be configured |

## Trust boundaries

- Browser → API: untrusted input, validated with zod; auth required.
- API → Soroban RPC: the RPC can lie about results. Confirmation relies on the
  transaction result and is cross-checked by the indexer, but a compromised RPC
  can delay/deny. Use multiple providers for high value.
- Indexer → database: events are authoritative but decoded by our code; decoding
  is unit tested.
- Wallet → contract: the wallet is the authority for the user's funds; the dApp
  cannot move funds without a signature.

## Non-goals

- Protecting users from their own key loss.
- Hiding amounts: Stellar transactions are public.
- Custody: W-Pay does not custody customer funds; escrow custody is contractual.

## Residual risks

Unaudited contracts, centralized admin powers, no live-network testing, and no
operational track record. Do not handle real value without an independent audit
and a staged rollout.
