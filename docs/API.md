# API reference

Base URL: `${API_PUBLIC_URL}/v1`. All requests and responses are JSON.
Amounts are decimal strings in base units (`"10000000"` = 1.0000000 XLM or the
asset's 7-decimal unit).

## Authentication

| Method | Header |
| --- | --- |
| Merchant/customer JWT | `Authorization: Bearer <token>` |
| API key | `X-API-Key: wpay_<prefix>_<secret>` |
| Wallet challenge | `POST /auth/wallet/challenge`, then `POST /auth/wallet/verify` |

API keys are stored as SHA-256 hashes with a searchable prefix and carry scopes
(`payments:read`, `payments:write`, `invoices:read`, …). Show the secret once at
creation; it cannot be retrieved later.

Wallet auth uses SEP-53: the server issues a single-use, expiring challenge
message containing the domain and nonce; the client signs it with
`signMessage` and posts the base64 signature. Login is only issued after the
signature verifies for the claimed `G...` address.

Every login, registration and wallet verification returns an `AuthSession`:

```json
{
  "accessToken": "<jwt>",
  "expiresIn": 3600,
  "refreshToken": "<opaque>",
  "refreshExpiresIn": 2592000,
  "user": { "id": "...", "role": "MERCHANT", "stellarAddress": "G..." }
}
```

Refresh tokens are opaque, stored only as SHA-256 hashes and grouped into a
family. `POST /auth/refresh` rotates the token and returns a new session body;
presenting an already-rotated token is treated as theft and revokes the whole
family. `POST /auth/logout` revokes one token; `POST /auth/logout-all` (bearer
auth) revokes every token for the user. Access tokens are short-lived JWTs and
remain valid until expiry after logout, so clients must clear them locally.

## Errors

```json
{ "error": { "code": "MERCHANT_INACTIVE", "message": "Merchant is not active", "requestId": "..." } }
```

`400` validation, `401` unauthenticated, `403` forbidden/scope, `404` not found,
`409` conflict/idempotency mismatch, `422` business rule, `429` rate limited,
`503` dependency or configuration unavailable. Responses never hide a missing
contract configuration behind a success.

## Endpoints

### Auth
| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | Create a user + merchant |
| POST | `/auth/login` | Email/password → access token |
| POST | `/auth/wallet/challenge` | Issue a signable challenge |
| POST | `/auth/wallet/verify` | Verify signature, issue token |
| POST | `/auth/refresh` | Rotate a refresh token |
| POST | `/auth/logout` | Revoke one refresh token |
| POST | `/auth/logout-all` | Revoke all refresh tokens for the user |
| GET | `/auth/me` | Current principal and scopes |

### Merchants
| Method | Path | Description |
| --- | --- | --- |
| POST | `/merchants` | Register a merchant |
| GET | `/merchants` | List (operator/admin sees all, merchant sees own) |
| GET | `/merchants/:id` | Profile |
| PATCH | `/merchants/:id` | Update name, settlement address, webhook URL |
| POST | `/merchants/:id/approve` | Operator approval (on-chain tx when configured) |
| POST | `/merchants/:id/suspend` | Suspend (on-chain tx when configured) |

A merchant creating its own record (`POST /merchants`) must pass an
`ownerAddress` equal to the `G...` wallet authenticated on the account; this
prevents registering a merchant that pays out to an unrelated address. The fee
is platform-controlled: non-staff requests always get the platform rate
(250 bps), and `PATCH /merchants/:id` does not change `feeBps`. Only requests
made by an `ADMIN`/`OPERATOR` principal may set `feeBps` at creation. Approve
and suspend are operator-only and build an on-chain transaction when the
merchant has a `registryId`; without contract configuration they update the
database only and return `transaction: null`.

### Payments
| Method | Path | Description |
| --- | --- | --- |
| POST | `/payments` | Create a payment/intent; `Idempotency-Key` required |
| GET | `/payments` | Cursor-paginated list |
| GET | `/payments/:id` | Detail with fee split |
| GET | `/payments/:id/intent` | Unsigned XDR for wallet signing |
| POST | `/payments/:id/confirm` | Confirm with `txHash`; verifies on-chain result |

### Invoices
| Method | Path | Description |
| --- | --- | --- |
| POST | `/invoices` | Create an invoice |
| GET | `/invoices` | List |
| GET | `/invoices/public/:number` | Public invoice view (no auth) |
| POST | `/invoices/public/:number/intent` | Public payment intent |
| GET | `/invoices/:id` | Merchant view |
| POST | `/invoices/:id/cancel` | Cancel an open invoice |

### Escrows
| Method | Path | Description |
| --- | --- | --- |
| POST | `/escrows` | Create an escrow |
| GET | `/escrows` | List |
| GET | `/escrows/:id` | Detail |
| POST | `/escrows/:id/release` | Release to merchant |
| POST | `/escrows/:id/refund` | Refund payer |
| POST | `/escrows/:id/dispute` | Open dispute |
| POST | `/escrows/:id/resolve` | Resolve with operator decision |

### Refunds
| Method | Path | Description |
| --- | --- | --- |
| POST | `/refunds` | Request a refund |
| GET | `/refunds` | List |
| POST | `/refunds/:id/approve` | Merchant decision (settlement-address authority) |
| POST | `/refunds/:id/reject` | Merchant rejection |

### Subscriptions
| Method | Path | Description |
| --- | --- | --- |
| POST | `/subscriptions/plans` | Create a plan |
| GET | `/subscriptions/plans` | List plans |
| POST | `/subscriptions` | Subscribe (prepaid cycles) |
| GET | `/subscriptions` | List subscriptions |
| POST | `/subscriptions/:id/cancel` | Cancel |

### Platform
| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness + component status |
| GET | `/health/ready` | public | Readiness: Postgres + Soroban RPC (`503` when either is down) |
| GET | `/health/metrics` | public | Prometheus exposition |
| GET | `/analytics/overview` | merchant | Volume, counts, fee totals |
| GET | `/settlements` | merchant | Settlement history |
| POST | `/settlements/batches` | merchant | Create a 1–20 entry settlement window |
| GET | `/settlements/:id` | merchant | Batch, entries and linked contract id |
| POST | `/settlements/:id/link` | merchant | Record the on-chain window id |
| POST | `/settlements/:id/intents` | merchant | Open/add-entry/close XDR intents |
| POST | `/settlements/:id/execute-intent` | merchant | Execute intent when `CLOSED` |
| POST | `/settlements/:id/cancel-intent` | admin | Cancel a non-executed window |
| GET | `/treasury/overview` | admin | Treasury balances and fees |
| POST | `/treasury/withdraw-intent` | admin | Unsigned withdraw XDR |
| GET/POST/DELETE | `/api-keys`, `/api-keys/:id` | merchant | Manage scoped keys |
| GET | `/notifications` | auth | Notifications |
| POST | `/notifications/:id/read` | auth | Mark read |
| POST | `/admin/pause` | admin | Build pause transaction |
| POST | `/admin/unpause` | admin | Build unpause transaction |
| GET | `/admin/audit-logs` | admin | Audit trail |
| GET | `/admin/indexer/status` | admin | Checkpoints and unresolved failures |
| GET | `/admin/indexer/failures` | admin | Dead-letter rows |
| POST | `/admin/indexer/failures/:id/resolve` | admin | Mark a reviewed failure resolved (audited) |
| GET | `/admin/merchants` | admin | All merchants |
| POST | `/transactions/submit` | public | Submit a signed XDR (signed by the caller) |

### Webhooks
| Method | Path | Description |
| --- | --- | --- |
| POST | `/webhooks` | Register endpoint + event filters |
| GET | `/webhooks` | List |
| DELETE | `/webhooks/:id` | Delete |
| GET | `/webhooks/:id/deliveries` | Delivery attempts |
| POST | `/webhooks/deliveries/:deliveryId/retry` | Manual retry |

Deliveries include `x-wpay-signature: sha256=<hex>` and
`x-wpay-timestamp: <unix>`. The HMAC-SHA256 is computed over
`"<timestamp>.<raw body>"`. Reject timestamps outside a five-minute window and
compare in constant time.

## Pagination

List endpoints accept `cursor` and `limit` (1–100) and return
`{ "items": [...], "nextCursor": "..." | null }`. Cursors are opaque,
signed/base64-encoded `(createdAt, id)` tuples.

## Idempotency

`POST /payments` requires `Idempotency-Key`. Replaying the same key with the same
body returns the original record; replaying it with a different body returns
`409 IDEMPOTENCY_CONFLICT`.
