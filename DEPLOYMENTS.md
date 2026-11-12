# Deployments

## Current status

**No W-Pay contract, API, database or indexer is deployed.** The customer
checkout UI is hosted on Vercel; it is static frontend hosting and cannot
process payments without the API and contracts.

| Component | Status | Evidence |
| --- | --- | --- |
| Contracts | not deployed | no contract ids or transactions exist |
| API | not deployed | no host; requires Postgres + secrets + contract ids |
| Indexer | not deployed | requires Postgres + RPC + contract ids |
| Checkout UI | deployed (frontend only) | <https://wpay-web.vercel.app> — HTTP 200 verified 2026-11-12 |
| Merchant dashboard | deployed (frontend only) | <https://wpay-merchant.vercel.app> — HTTP 200 verified 2026-11-12 |
| Admin dashboard | deployed (frontend only) | <https://wpay-admin.vercel.app> — HTTP 200 verified 2026-11-12 |

### Frontend deployment record

| Host | Project | URL | Deployed | Verified |
| --- | --- | --- | --- | --- |
| Vercel (team `w-pay`) | `wpay-web` | https://wpay-web.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Checkout</title>` |
| Vercel (team `w-pay`) | `wpay-merchant` | https://wpay-merchant.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Merchant</title>` |
| Vercel (team `w-pay`) | `wpay-admin` | https://wpay-admin.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Admin</title>` |

The pages default to `NEXT_PUBLIC_API_URL` when set, otherwise
`http://localhost:4000`. Because no API is deployed, invoice lookup and logins
fail in the live pages; this is expected and is not a working payment gateway.

`.env.example` leaves every `CONTRACT_*_ID` empty and the API returns explicit
"not configured" responses.

## How to record a real deployment

Only add a row after you have personally verified it on a block explorer:

```markdown
| Network | Contract | Id | Deploy tx | Wasm sha256 | Date | Verifier |
| --- | --- | --- | --- | --- | --- | --- |
| testnet | payment-router | C... | abc... | 1f2e... | 2026-01-01 | @handle |
```

Also record:

- admin addresses and whether they are multisig;
- fee configuration and caps at deploy time;
- the `STELLAR_NETWORK`, RPC URL and ledger of first event;
- a link to the verification call (`get_admin`, `fee`, `is_active`) output.

Do not copy contract ids from another project or from a test fixture. A
snapshot's `C...` id is not a deployment.
