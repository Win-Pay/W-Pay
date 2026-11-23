# Deployment runbook

This describes how to deploy. **Testnet:** all 16 contracts were deployed on
2026-11-12 and one end-to-end payment was verified; ids and transactions are in
[DEPLOYMENTS.md](../DEPLOYMENTS.md). **No production/mainnet deployment has been
performed**, and the production steps below have not been executed.

## 0. Preconditions

- [ ] Contracts audited (none has been) or an explicit risk acceptance signed.
- [ ] `wasm32v1-none` build reproducible; artifact hashes recorded.
- [ ] Postgres with PITR and a tested restore.
- [ ] Secrets in a manager (not `.env`, not CI logs).
- [ ] `ADMIN_ADDRESSES` and contract admin keys in hardware wallets or a
      multisig; no admin key on an application server. See
      [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md) for the 2-of-3 design and ceremony.
- [ ] `CORS_ORIGINS` lists every browser origin (comma-separated). Production
      does not add localhost automatically.
- [ ] `WEB_PUBLIC_URL` and `API_PUBLIC_URL` are real public **HTTPS** origins
      (no placeholders). Production refuses to boot otherwise.
- [ ] `JWT_SECRET` is 32+ random characters and not a template value.
- [ ] `REDIS_URL` points at a reachable Redis (required in production unless
      `ALLOW_IN_MEMORY_RATE_LIMIT=1` is deliberately set).
- [ ] `TRUST_PROXY` matches the proxy/ingress hop count (defaults to `1`) so
      rate limits key on the client address, not the ingress.
- [ ] Decide cookie scope: default `SameSite=None` works across sites but
      depends on browser third-party-cookie policy; set a first-party
      `COOKIE_DOMAIN` and `REFRESH_COOKIE_SAMESITE=lax` where possible.
- [ ] Synchronized clocks and a reachable `STELLAR_RPC_URL`; `/v1/health/ready`
      probes it and returns `503` when it is down.
- [ ] Domain, TLS certificate, and DNS for API + checkout.

## 1. Deploy contracts

```bash
pnpm contracts:build
# Inspect sizes/hashes
sha256sum packages/contracts/target/wasm32v1-none/release/*.wasm
```

### Testnet (automated, idempotent)

```bash
SOROBAN_SOURCE_SECRET=S... node scripts/deploy-testnet.cjs
node scripts/e2e-testnet.cjs
```

The deployer writes `deployments/testnet.json` with contract ids, upload/create
transaction hashes and WASM hashes, and resumes by verifying existing contract
data. `e2e-testnet.cjs` settles one payment and verifies the event and balances;
re-running verifies the recorded payment instead of paying twice. The Testnet
deployer in this repository is a throwaway key — do not reuse it for production.

### Production

Deploy each contract with the Stellar CLI using an account you control:

```bash
stellar contract deploy \
  --wasm packages/contracts/target/wasm32v1-none/release/wpay_payment_router.wasm \
  --source <admin-identity> --network testnet
```

Then initialize roles and configuration in dependency order:
`role-manager` → `configuration-manager` → `fee-manager` →
`merchant-registry` → `emergency-pause` → `treasury-vault` → operational
contracts. Record every contract id and the transaction hash. Verify with
`stellar contract invoke --id <id> -- get_admin` (or the equivalent read call)
before trusting the id.

Do **not** publish ids until you have verified them on a block explorer.

## 2. Database

```bash
pnpm db:migrate     # prisma migrate deploy
```

Run migrations before rolling pods. Take a backup first; a failed migration is
not automatically reversible. Seed only the first time. The repository currently
has 8 migrations; `0008_settlement_automation` adds settlement batch/entry
columns and indexes. The hosted Vercel/Neon deployment was last migrated at 7,
so run `pnpm db:migrate` against Neon before deploying the API code that uses
those columns.

Migration 0008 was validated locally on 2026-11-22 against PostgreSQL 16 through
the real Prisma runner: migrations 0001–0007 were deployed, representative
merchant/payment/invoice/window/entry rows were inserted, then 0008 was deployed
with `prisma migrate deploy`. Every row count and pre-existing value was
unchanged; the new columns received their documented defaults; the
`Payment_settlementWindowId_fkey` link enforced references and set the column
to `NULL` on window deletion; duplicate `batchKey` values were rejected while
multiple `NULL`s were allowed; and `prisma migrate diff` reported
`No difference detected` between the migrated database and `schema.prisma`.
The migration is additive only (no drops or renames) and uses constructs
supported by Neon Postgres. Its `CREATE INDEX` statements take a normal write
lock, so apply it during a low-traffic window.

Apply it to Neon with the owner connection string; this requires credentials and
authorization that are not available in this workspace:

```bash
DATABASE_URL='postgresql://<owner>@<neon-host>/<db>?sslmode=require' pnpm db:migrate
```

Then confirm 8 applied migrations and redeploy the API before calling any
settlement-automation endpoint. Do not mark the hosted migration complete until
that command succeeds and the deployed API reports the new routes.

`DATABASE_URL=... pnpm db:backup` writes a custom-format dump, validates its
archive TOC when `pg_restore` is installed (otherwise warns), and writes a
`.sha256` sidecar;
`pnpm db:restore-drill <dump>` restores it into a scratch database and compares
every public table plus applied migrations. Both scripts normalize the URL
through `scripts/pg-url.mjs`, which removes Prisma-only parameters such as
`schema=public` before invoking libpq while preserving TLS settings and
percent-encoded credentials. The daily workflow in
`.github/workflows/backup.yml` does both and fails closed on mismatch, and
refuses to upload a plaintext production dump.

The production workflow requires two **environment** secrets on the
`production` environment: `DATABASE_URL` and `BACKUP_GPG_PASSPHRASE` (symmetric
AES-256, also used by the verify job). Configure them with
`gh secret set DATABASE_URL --env production` and
`gh secret set BACKUP_GPG_PASSPHRASE --env production`, restrict the environment
to `main`, then run `gh workflow run backup.yml --ref main`. Do not run the
workflow until both secrets exist; it fails at preflight and opens a
deduplicated failure issue. As of 2026-11-23 the environment exists but has no
protection rules, and the secret names are not readable with the current token.
Scheduled run `45158391099` (commit `66d3fac`) failed at preflight with both
secret errors; its `restore-drill` job separately failed because
`?schema=public` was passed to `pg_dump`. That URL bug is fixed and covered by
`pnpm test:scripts`, and `verify-backup` now declares the `production`
environment. No successful production run exists yet. The local encrypted drill
passed on 2026-11-23 with the PostgreSQL 16 client (checksum and TOC verified,
all 21 public tables, eight migrations, 1s restore), but a local drill is not
production evidence. Full steps and acceptance criteria are in
[docs/DISASTER_RECOVERY.md](DISASTER_RECOVERY.md#enabling-production-backups).

For a manual encrypted off-site copy, export `BACKUP_GPG_RECIPIENT` (public key)
or `BACKUP_GPG_PASSPHRASE` before running the backup; the script writes
`<dump>.gpg`, removes the plaintext and checksums the ciphertext. Upload only
the ciphertext plus `.sha256` to storage in a different account/region; keep the
private key/passphrase offline. Set `BACKUP_RETENTION_DAYS` to prune old
`wpay-*` artifacts. Managed Postgres PITR is still required for RPO in minutes.

## 3. Images

```bash
docker build -f infra/docker/api.Dockerfile -t ghcr.io/<org>/wpay-api:<sha> .
docker build -f infra/docker/indexer.Dockerfile -t ghcr.io/<org>/wpay-indexer:<sha> .
docker build -f infra/docker/next.Dockerfile --build-arg APP=web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t ghcr.io/<org>/wpay-web:<sha> .
```

The deploy workflow builds and pushes these, then runs `helm upgrade` from a
protected environment.

### Single-host Docker Compose

For a VM or dedicated host, the repository includes a production stack with
Postgres, password-protected Redis, a one-shot migration job, the API, the
indexer and Caddy for automatic HTTPS:

```bash
cp .env.production.example .env.production
# edit every value: API_DOMAIN, POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET,
# CORS_ORIGINS, contract ids, SOROBAN_SOURCE_SECRET if used
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

`API_DOMAIN` must already resolve to the host and ports 80/443 must be open;
Caddy obtains and renews the certificate. Postgres and Redis are not published
outside the Compose network. The `migrate` service must exit 0 before the API
and indexer start. Back up `postgres-data` and keep `.env.production` out of
version control.

## 4. Kubernetes

```bash
kubectl create namespace wpay
kubectl -n wpay create secret generic wpay-secrets \
  --from-literal=DATABASE_URL="..." \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
helm upgrade --install wpay helm/wpay -n wpay \
  --set image.registry=ghcr.io/<org> --set image.tag=<sha> \
  --set config.API_PUBLIC_URL=https://api.example.com \
  --set config.WEB_PUBLIC_URL=https://pay.example.com
```

`k8s/` contains plain manifests if Helm is not used; they are equivalent.

## 5. Post-deploy verification

```bash
curl https://api.example.com/v1/health
curl https://api.example.com/v1/health/ready
curl https://api.example.com/v1/health/metrics | head
```

Expected: `/v1/health` returns `database: "up"`, `soroban: "up"` (the API calls
`getLatestLedger`; `not_configured` when no contracts are configured) and
`contracts` listing all 16 ids. `/v1/health/ready` returns `200` with
`ready: true` only when both Postgres and Soroban RPC answer; otherwise it
returns `503`. If contracts are empty, stop: the deployment is incomplete and
payment intents will return 503.

`/v1/health/metrics` also exposes the settlement automation series described in
[SETTLEMENT.md](SETTLEMENT.md#metrics): eligible payments, pending batches and
their age, run outcomes, retries by bounded reason, execution duration,
reconciliation failures, automation mode and API-side indexer freshness. Alert
rules for a two-hour backlog, batches in backoff and reconciliation
inconsistencies are in `monitoring/alerts.yml`. The hosted API only returns these
series after this code is deployed; the 2026-11-22 hosted build does not.

Operator checks:

```bash
curl -H "Authorization: Bearer <admin-jwt>" https://api.example.com/v1/admin/indexer/status
curl -H "Authorization: Bearer <admin-jwt>" https://api.example.com/v1/admin/indexer/failures
curl -H "Authorization: Bearer <admin-jwt>" https://api.example.com/v1/admin/indexer/consistency
```

Indexer unresolved failures also appear in its `/health` (`degraded`) and
`wpay_indexer_unresolved_failures`. Review a failure before resolving it; the
resolve endpoint is audit-logged. Historical replay is
`POST /v1/admin/indexer/replay` with `{"contract":"...","fromLedger":123}`; it is
bounded by `maxPages` and audit-logged.

Settlement batches can still be created with `POST /v1/settlements/batches`
(1–20 entries, capped because a 50-entry execute exceeded the local Soroban
budget) and advanced through link/intents/execute. Automatic settlement is
opt-in and must be configured deliberately:

```bash
SETTLEMENT_AUTOMATION=off          # default: no automatic batches
SETTLEMENT_OPERATOR_ADDRESS=G...   # or derive it from SOROBAN_SOURCE_SECRET
SETTLEMENT_HOLD_HOURS=24
SETTLEMENT_MAX_ENTRIES=20
SETTLEMENT_MAX_STEPS=5
SETTLEMENT_RETRY_MINUTES=30
SETTLEMENT_DELAY_ALERT_MINUTES=120
```

`prepare` creates batches from due payments; `execute` additionally requires
`SOROBAN_SOURCE_SECRET` and signs `open/add/close/execute` as the operator. The
maintenance endpoint runs it after the indexer pass. Start with `prepare` and a
supervised `POST /v1/admin/settlements/run` before enabling `execute`. After a
failure, inspect `GET /v1/admin/settlements/automation` and only then clear the
backoff with `POST /v1/admin/settlements/:id/retry` (ADMIN). Check
`GET /v1/admin/settlements/reconciliation` after the first run.

Then exercise one real payment on testnet end to end, with a small amount, and
confirm the indexer writes the settled payment. Only after that should mainnet
be considered, and only with real funds you can afford to lose.

## 5b. Frontends

Point each Vercel project at the API and list every origin in `CORS_ORIGINS`.
The full procedure and exact values are in [VERCEL.md](VERCEL.md). Remember that
`NEXT_PUBLIC_API_URL` is baked into the bundle, so changing it requires a new
deployment.

## 5c. Current Vercel deployment

The API is deployed at https://wpay-api-six.vercel.app (project `wpay-api`) with
Neon Postgres, Upstash Redis and all 16 Testnet contract ids. The three
frontends are rebuilt against it. `GET /v1/health` and `/v1/health/ready` were
verified against the live database and Soroban RPC on 2026-11-13.

Serverless functions are request-scoped, so two long-running processes cannot
stay resident on Vercel:

- the webhook delivery worker (the Vercel deployment sets `WEBHOOK_WORKER=off`);
- the contract-event indexer (`apps/indexer`), which keeps the operational
  projection in sync with on-chain state.

To keep both making progress without a worker host, two schedulers call the
same endpoint: `vercel.json` schedules a daily cron (`0 2 * * *`) and
`.github/workflows/maintenance.yml` runs every 15 minutes (GitHub may delay
scheduled runs under load). Run `gh workflow run maintenance.yml` for an
immediate pass. `GET /v1/internal/maintenance` is disabled unless
`CRON_SECRET` is set in both Vercel and the GitHub repository secrets, and only
accepts `Authorization: Bearer $CRON_SECRET`; it drains up to 50 due webhook
deliveries, runs one indexer pass over every configured contract from the
stored cursors, then runs settlement automation in the configured mode
(`off` by default). All operations are idempotent, so overlapping runs are safe.
The repository secret is configured and a manual dispatch on 2026-11-13
returned `ok:true` across all 16 contracts. The hosted function predates the
settlement-automation code and migration 0008, so those steps only take effect
after the owner redeploys and migrates. A check on 2026-11-22 confirmed the
stale build: `GET /v1/admin/settlements/automation` returns `404 NOT_FOUND`,
while `/v1/health` and `/v1/health/ready` remain `200`. Lag is minutes rather than the day
a Vercel-only cron would leave; real-time behaviour still needs the
Compose/Kubernetes workers. Health still reports
`database: "up"` because it checks the connection, not worker liveness. Refund
approval records the decision even when the on-chain refund id is not indexed
yet; once the indexer links it, `POST /v1/refunds/:id/approve-transaction`
returns the settlement-wallet approval transaction (`409 REFUND_NOT_LINKED`
before the link exists). See [VERCEL.md](VERCEL.md) for the build layout.

## 6. Rollback

```bash
helm rollback wpay -n wpay
```

Images are immutable by tag; redeploy the previous SHA. Database rollback is a
restore, not a down-migration — write a restore drill before you need it.

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
