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
not automatically reversible. Seed only the first time.
`DATABASE_URL=... pnpm db:backup` writes a custom-format dump;
`pnpm db:restore-drill <dump>` restores it into a scratch database and compares
row counts. The daily workflow in `.github/workflows/backup.yml` does both.

For an encrypted off-site copy, export `BACKUP_GPG_RECIPIENT` (public key) before
running the backup; the script writes `<dump>.gpg`, removes the plaintext and
prints the ciphertext hash. Upload only the `.gpg` file to storage in a
different account/region; keep the private key offline. Managed Postgres PITR
is still required for RPO in minutes.

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

Operator checks:

```bash
curl -H "Authorization: Bearer <admin-jwt>" https://api.example.com/v1/admin/indexer/status
curl -H "Authorization: Bearer <admin-jwt>" https://api.example.com/v1/admin/indexer/failures
```

Indexer unresolved failures also appear in its `/health` (`degraded`) and
`wpay_indexer_unresolved_failures`. Review a failure before resolving it; the
resolve endpoint is audit-logged. Settlement batches are created with
`POST /v1/settlements/batches` (1–20 entries, capped because a 50-entry execute
exceeded the local Soroban budget) and advanced through link/intents/execute.

Then exercise one real payment on testnet end to end, with a small amount, and
confirm the indexer writes the settled payment. Only after that should mainnet
be considered, and only with real funds you can afford to lose.

## 5b. Frontends

Point each Vercel project at the API and list every origin in `CORS_ORIGINS`.
The full procedure and exact values are in [VERCEL.md](VERCEL.md). Remember that
`NEXT_PUBLIC_API_URL` is baked into the bundle, so changing it requires a new
deployment.

## 6. Rollback

```bash
helm rollback wpay -n wpay
```

Images are immutable by tag; redeploy the previous SHA. Database rollback is a
restore, not a down-migration — write a restore drill before you need it.

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
