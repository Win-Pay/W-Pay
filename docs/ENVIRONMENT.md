# Environment variables

All variables are read at process start. `.env.example` is the canonical list;
this page explains semantics and defaults. Never commit real values.

## Required

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `JWT_SECRET` | — | ≥ 32 chars; rotating it invalidates all sessions |
| `STELLAR_NETWORK` | `testnet` | `testnet`, `futurenet` or `mainnet` |

## API

| Variable | Default | Description |
| --- | --- | --- |
| `API_PORT` | `4000` | HTTP port |
| `API_PUBLIC_URL` | `http://localhost:4000` | Used in wallet-auth domain binding and links |
| `WEB_PUBLIC_URL` | `http://localhost:3000` | Checkout links and CORS origin |
| `CORS_ORIGINS` | empty | Extra comma-separated browser origins; production does not add localhost automatically |
| `JWT_EXPIRES_IN` | `1h` | Access-token lifetime (`30m`, `1h`, `1d`, …) |
| `JWT_REFRESH_TTL_DAYS` | `30` | Refresh-token lifetime in days |
| `REDIS_URL` | empty locally, **required in production** | Shared rate-limit counters; the API refuses to boot in production without it |
| `ALLOW_IN_MEMORY_RATE_LIMIT` | `0` | Set to `1` only for a deliberate single-replica production deployment |
| `TRUST_PROXY` | `1` in production, `0` locally | Express trust-proxy hop count; required so `request.ip` is the client behind Caddy/ingress |
| `REFRESH_COOKIE_SAMESITE` | `none` in production, `lax` locally | SameSite mode for refresh/CSRF cookies; `none` requires cross-site frontends |
| `COOKIE_DOMAIN` | empty | Optional parent domain for first-party cookies |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-IP quota; Redis-backed when `REDIS_URL` is set |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failed sign-ins per account before a temporary lock |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Sliding window for the per-account lock; a successful login clears it |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `ADMIN_ADDRESSES` | empty | Comma-separated `G...` addresses granted admin on login |
| `SOROBAN_SOURCE_SECRET` | empty | Only for automated flows; never commit |

Production boot is fail-closed: `API_PUBLIC_URL`, `WEB_PUBLIC_URL` and
`CORS_ORIGINS` must be HTTPS non-placeholder hosts, `JWT_SECRET` must not
contain a template value, and Redis must be configured. The API exits with a
configuration error instead of starting degraded.

## Contract ids

Each contract has a dedicated variable (`CONTRACT_PAYMENT_ROUTER_ID`, …). Empty
means "not configured": endpoints that need it return `503`, intents return
`null`, and the health endpoint reports zero configured contracts. This is the
expected state until you deploy.

## Networks

`STELLAR_NETWORK` selects the RPC and Horizon endpoints from
`@wpay/config`. Only mainnet should ever hold real value; testnet and futurenet
are for development and are reset by the Stellar team without notice.

## Indexer

| Variable | Default | Description |
| --- | --- | --- |
| `INDEXER_PORT` | `4100` | Health/metrics port |
| `INDEXER_START_LEDGER` | `1` | First ledger when no checkpoint exists |
| `INDEXER_BATCH_SIZE` | `100` | Events per RPC page |
| `INDEXER_INTERVAL_MS` | `5000` | Poll interval |

## Webhooks

| Variable | Default | Description |
| --- | --- | --- |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | Retries before dead-lettering |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt timeout |
| `WEBHOOK_WORKER` | `on` | Disable when running delivery separately |

## Serverless cron catch-up

| Variable | Default | Description |
| --- | --- | --- |
| `CRON_SECRET` | empty | Enables `GET /v1/internal/maintenance` and authenticates the Vercel cron (`Authorization: Bearer $CRON_SECRET`); the route is hidden when unset |
| `INDEXER_START_LEDGER` | `1` | First ledger to scan when no cursor exists |
| `INDEXER_BATCH_SIZE` | `100` | Events fetched per contract per pass |

## Frontends

`NEXT_PUBLIC_API_URL` is compiled into each Next.js client bundle. It must be
the public HTTPS API origin and must appear in the API's CORS allow-list
(`WEB_PUBLIC_URL` plus `CORS_ORIGINS`). A production build without it renders a
configuration error; it never silently falls back to localhost. Each app has an
`.env.example` and `vercel.json`; see [VERCEL.md](VERCEL.md).

`VITE_API_URL` is the equivalent for the mobile PWA.

The API returns `networkPassphrase` and `contractId` inside every transaction
intent, so the browser does not need `NEXT_PUBLIC_STELLAR_NETWORK`,
`NEXT_PUBLIC_STELLAR_RPC_URL` or `NEXT_PUBLIC_CONTRACT_ID`. Those values stay
server-side in `STELLAR_NETWORK`, `STELLAR_RPC_URL` and `CONTRACT_*_ID`.

Browser apps keep the access token and CSRF token in memory only. The rotating
refresh token is an `HttpOnly`, `Secure` cookie, so a reload calls
`GET /auth/csrf` and then re-exchanges the cookie. Cross-site Vercel frontends
need `REFRESH_COOKIE_SAMESITE=none` (the production default); third-party cookie
blocking can still affect them, so a first-party layout
(`app.example.com` + `api.example.com`) with `COOKIE_DOMAIN` and
`SameSite=Lax` is preferred. Do not put API origins behind a wildcard: the API
checks the exact browser origin on state-changing requests.

The Next.js production builds also set a Content-Security-Policy whose
`connect-src` includes the `NEXT_PUBLIC_API_URL` origin. Setting the variable at
build time is therefore required for API calls as well as for the UI.

## Secrets management

- Local: `.env` (git-ignored).
- Kubernetes: `Secret` created out-of-band or via External/Sealed Secrets; the
  committed `k8s/secret.example.yaml` contains placeholders only.
- CI: repository/environment secrets; no secret is echoed in logs.
- Rotate `JWT_SECRET`, `SOROBAN_SOURCE_SECRET` and database credentials on a
  schedule and after any suspected exposure.
