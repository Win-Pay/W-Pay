# Deployment runbook

This describes how to deploy. **Nothing has been deployed by this repository**;
the steps below have not been executed against a production network.

## 0. Preconditions

- [ ] Contracts audited (none has been) or an explicit risk acceptance signed.
- [ ] `wasm32v1-none` build reproducible; artifact hashes recorded.
- [ ] Postgres with PITR and a tested restore.
- [ ] Secrets in a manager (not `.env`, not CI logs).
- [ ] `ADMIN_ADDRESSES` and contract admin keys in hardware wallets or a
      multisig; no admin key on an application server.
- [ ] Domain, TLS certificate, and DNS for API + checkout.

## 1. Deploy contracts

```bash
pnpm contracts:build
# Inspect sizes/hashes
sha256sum packages/contracts/target/wasm32v1-none/release/*.wasm
```

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

## 3. Images

```bash
docker build -f infra/docker/api.Dockerfile -t ghcr.io/<org>/wpay-api:<sha> .
docker build -f infra/docker/indexer.Dockerfile -t ghcr.io/<org>/wpay-indexer:<sha> .
docker build -f infra/docker/next.Dockerfile --build-arg APP=web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t ghcr.io/<org>/wpay-web:<sha> .
```

The deploy workflow builds and pushes these, then runs `helm upgrade` from a
protected environment.

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

Expected: `status: "ok"`, `database: "up"`, `soroban: "up"`, and
`contracts` listing all 16 ids. If contracts are empty, stop: the deployment is
incomplete and payment intents will return 503.

Then exercise one real payment on testnet end to end, with a small amount, and
confirm the indexer writes the settled payment. Only after that should mainnet
be considered, and only with real funds you can afford to lose.

## 6. Rollback

```bash
helm rollback wpay -n wpay
```

Images are immutable by tag; redeploy the previous SHA. Database rollback is a
restore, not a down-migration — write a restore drill before you need it.

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
