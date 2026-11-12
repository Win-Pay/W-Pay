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
| `JWT_EXPIRES_IN` | `1h` | Token lifetime |
| `RATE_LIMIT_PER_MINUTE` | `120` | In-process limiter; per replica |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `ADMIN_ADDRESSES` | empty | Comma-separated `G...` addresses granted admin on login |
| `SOROBAN_SOURCE_SECRET` | empty | Only for automated flows; never commit |

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

## Frontends

`NEXT_PUBLIC_API_URL` and `VITE_API_URL` are compiled into the client bundles.
They must be reachable from the browser and must match the API's CORS origin.

## Secrets management

- Local: `.env` (git-ignored).
- Kubernetes: `Secret` created out-of-band or via External/Sealed Secrets; the
  committed `k8s/secret.example.yaml` contains placeholders only.
- CI: repository/environment secrets; no secret is echoed in logs.
- Rotate `JWT_SECRET`, `SOROBAN_SOURCE_SECRET` and database credentials on a
  schedule and after any suspected exposure.
