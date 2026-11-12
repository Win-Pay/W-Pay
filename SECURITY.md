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
- No contract has been audited or deployed. Treat the code as unaudited.

## Known issues and accepted risks

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and the findings section of
[docs/AUDIT.md](docs/AUDIT.md), including:

- in-process rate limiting (per replica, not global);
- no replay cache for wallet challenges beyond expiry/single-use storage;
- contract admin keys are powerful (fee cap, pause, upgrade proposals);
- no external audit, no formal verification.
