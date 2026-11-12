# Installation

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20 (22 LTS recommended) | CI uses 22 |
| pnpm | 12.16.1 | `corepack enable && corepack prepare pnpm@12.16.1 --activate` |
| Rust | 1.84+ stable | For contracts |
| `wasm32v1-none` target | — | `rustup target add wasm32v1-none` |
| PostgreSQL | 16 | Or use `docker compose up postgres` |
| Docker | optional | Images for API/indexer/web |

## Steps

```bash
git clone <your-fork> wpay && cd wpay
pnpm install
```

If pnpm refuses to run dependency build scripts, install with the explicit
allow-list (this is a supply-chain safeguard, not a bug):

```bash
pnpm install --allow-build=prisma --allow-build=@prisma/client \
  --allow-build=@prisma/engines --allow-build=esbuild \
  --allow-build=@scarf/scarf --allow-build=sharp
```

### Environment

```bash
cp .env.example .env
openssl rand -hex 32                     # put in JWT_SECRET (32+ characters)
```

Set `DATABASE_URL`. The API validates config at import time, so every command
(`build`, `typecheck`, `test`, `dev`) needs `DATABASE_URL` and `JWT_SECRET` in
the environment or `.env`.

### Database

```bash
pnpm db:generate
pnpm db:migrate          # applies migrations/0001_init
pnpm db:seed             # creates roles, fee config, admin; prints generated password
```

`db:seed` refuses to overwrite an existing admin email. Change the password
immediately after first login.

### Run

```bash
pnpm dev                 # Turbo: api + web + dashboards
```

Ports: API 4000, web 3000, merchant 3001, admin 3002, indexer 4100,
mobile dev 5173.

### Contracts

```bash
rustup target add wasm32v1-none
pnpm contracts:test
pnpm contracts:build     # writes packages/contracts/target/wasm32v1-none/release/*.wasm
```

The build script sets `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1`,
which Soroban SDK 29 requires.

### Verifying a fresh checkout

```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm contracts:test && pnpm contracts:build
```

No deployment occurs during installation, and no network credentials are
needed to run the tests.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `JWT_SECRET must be at least 32 characters` | Set the env var before importing the API |
| `ERR_PNPM_IGNORED_BUILDS` | Use `--allow-build=...` (see above) |
| `prisma generate` cannot find schema | Run from repo root; `DATABASE_URL` must be set |
| `wasm32v1-none` target missing | `rustup target add wasm32v1-none` |
| Next build cannot resolve `@wpay/ui/styles.css` | Ensure the package is built (`pnpm --filter @wpay/ui build`) |
