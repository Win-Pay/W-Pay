# Security policy

## Reporting

Email `security@wpay.example` with steps to reproduce, affected component and
impact. Do not open a public issue. We aim to acknowledge within 72 hours. This
is a template address for a project that has not been published; replace it
before publishing.

## Scope

In scope: contracts in `packages/contracts`, API auth and payment flows, webhook
signing, SDK transaction building, deployment manifests.

Out of scope: the Stellar network itself, third-party wallets, and
infrastructure you operate without following this repository's guidance.

## Security model in brief

- Keys never leave the user's wallet. The API builds unsigned transactions and
  submits only signed XDR.
- Privileged contract calls require `require_auth()` plus role checks; refund
  approval requires the merchant settlement address.
- API keys are hashed (SHA-256) and scoped; JWTs are short-lived.
- Webhooks are HMAC-signed with timestamped bodies.
- Health and metrics endpoints are public but expose no secrets.
- Webhook URLs are resolved and blocked if they point at private/reserved
  addresses; redirects are refused. Registration and delivery both check.
- Rate limits use Redis when `REDIS_URL` is set; otherwise the API warns and
  falls back to per-process counters.
- No contract has been independently audited. The 16 contracts are deployed on
  **Testnet only**, under a throwaway deployer key with no real funds.

## Known issues and accepted risks

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and the findings section of
[docs/AUDIT.md](docs/AUDIT.md), including:

- per-replica rate limiting when Redis is not configured;
- wallet challenges are single-use and expiry-bound in Postgres, but there is no
  additional replay cache;
- contract admin keys are powerful (fee cap, pause, upgrade proposals);
- JWT tokens are stored in `localStorage` in the dashboards;
- the browser extension requests broad host permissions;
- no external audit, no formal verification, no mainnet deployment;
- `cargo audit` reports RUSTSEC-2026-0387 in `crypto-bigint` 0.5.5, reached via
  `soroban-env-host` 29.0.1. There is no compatible patched release yet; CI
  ignores it explicitly and it is re-checked on SDK upgrades.
