# Vercel deployment

The API and the three customer-facing Next.js apps are deployed as separate
Vercel projects in the `w-pay` team:

| Vercel project | Local app | Production URL |
| --- | --- | --- |
| `wpay-api` | `apps/api` | https://wpay-api-six.vercel.app |
| `wpay-web` | `apps/web` | https://wpay-web.vercel.app |
| `wpay-merchant` | `apps/merchant-dashboard` | https://wpay-merchant.vercel.app |
| `wpay-admin` | `apps/admin-dashboard` | https://wpay-admin.vercel.app |

As of 2026-11-13 the API is live on Vercel with Neon Postgres and Upstash Redis
marketplace integrations, all seven Prisma migrations applied, and the 16
Testnet contract ids configured. `GET /v1/health` returns `database: "up"`,
`soroban: "up"` and all 16 contracts; `/v1/health/ready` returns `ready: true`;
`/v1/auth/csrf` sets a `Secure; HttpOnly; SameSite=None` cookie; a login attempt
for an unknown account returns `401` (a real query against Neon, not a
fallback). All three frontends were rebuilt with
`NEXT_PUBLIC_API_URL=https://wpay-api-six.vercel.app` and their bundles were
inspected to contain that origin.

The project also lists a `winpay.com` custom domain. Vercel reports it as
`misconfigured: true`: the name currently resolves to Cloudflare
(`104.21.40.37`, `172.67.175.44`) and serves an unrelated PHP site, not this
Next.js app. To attach it, at the Cloudflare DNS zone for `winpay.com` either:

- set the apex `A` records to `216.198.79.1` and `64.29.17.1`, or
- set a `CNAME` for the apex/`www` to `e80183d1a58924f7.vercel-dns-017.com`
  (`cname.vercel-dns.com` is the fallback), with Cloudflare proxying disabled.

Then click verify on the domain in the Vercel project. Until the record is
correct, use the `*.vercel.app` URLs above; do not claim `winpay.com`.

The `w-pay` team is on the Hobby plan, which only supports daily cron jobs, so
a Vercel cron cannot substitute for the webhook worker or the indexer. Both
need the long-running Compose/Kubernetes processes described in
[DEPLOYMENT.md](DEPLOYMENT.md) §5c.

## 0. How the API runs on Vercel

The repository root has `vercel.json` and `api/index.js` is a generated
artifact (git-ignored). The build command:

1. `pnpm turbo build --filter=@wpay/api^...` compiles the workspace packages
   and generates the Prisma client.
2. `pnpm exec prisma generate` regenerates the client for the root install so
   the traced function can resolve `@prisma/client`.
3. `node scripts/build-serverless.mjs` bundles the Nest entrypoint with
   esbuild and SWC. Bundling is required because Vercel's Node launcher cannot
   `require()` ESM-only packages, which `@stellar/stellar-sdk`'s CJS build does
   for `@noble/hashes`. SWC emits the decorator metadata Nest DI needs;
   `@prisma/client` stays external so the engine binaries are traced.
4. A non-empty `public/` is produced so Vercel accepts the static output.

`vercel.json` rewrites every path to the function, so Nest's global `/v1`
prefix is preserved. The in-process webhook delivery worker is disabled
(`WEBHOOK_WORKER=off`) and the indexer does not run on Vercel: serverless
functions are request-scoped. Both need a long-running worker (Compose or
Kubernetes per [DEPLOYMENT.md](DEPLOYMENT.md)) pointing at the same database.

## 1. Environment variables for a fresh deployment

The browser apps need a public HTTPS API origin. The API requires real HTTPS
`API_PUBLIC_URL`/`WEB_PUBLIC_URL`, `JWT_SECRET`, `DATABASE_URL` (and
`DATABASE_URL_UNPOOLED` for migrations), `REDIS_URL`, the 16 `CONTRACT_*_ID`
values from `deployments/testnet.json`, and all three frontend origins:

```env
API_PUBLIC_URL=https://wpay-api-six.vercel.app
WEB_PUBLIC_URL=https://wpay-web.vercel.app
CORS_ORIGINS=https://wpay-web.vercel.app,https://wpay-merchant.vercel.app,https://wpay-admin.vercel.app
```

Cross-site refresh cookies default to `SameSite=None; Secure`. If the browser
blocks third-party cookies, serve the API on a first-party subdomain and set
`COOKIE_DOMAIN` and `REFRESH_COOKIE_SAMESITE=lax` instead. Set `TRUST_PROXY` to
the ingress hop count (default `1`).

Verify before touching the frontends:

```bash
curl -s https://wpay-api-six.vercel.app/v1/health
# {"status":"ok","database":"up","soroban":"up",...}
```

The serverless entrypoint boots with `swagger: false`, so `/docs` is not served
on Vercel; use a Compose/Kubernetes deployment when you need the interactive
OpenAPI UI.

## 2. Vercel project settings

For each project:

| Setting | Value |
| --- | --- |
| Framework preset | Next.js |
| Root directory | `apps/web`, `apps/merchant-dashboard` or `apps/admin-dashboard` |
| Install command | `cd ../.. && pnpm install --frozen-lockfile` |
| Build command | `cd ../.. && pnpm turbo build --filter=<package>...` |
| Output directory | leave Vercel's Next.js default |

`<package>` is `@wpay/web`, `@wpay/merchant-dashboard` or
`@wpay/admin-dashboard`. The committed `vercel.json` in each app already sets
the install/build commands; the Turbo filter builds shared packages
(`@wpay/sdk`, `@wpay/hooks`, `@wpay/ui`, …) before the app.

## 3. Environment variables

Each app needs exactly one build-time public variable:

| Variable | Value | Scope |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://wpay-api-six.vercel.app` | Production, Preview, Development |

Set it per project:

```bash
cd apps/web
vercel link                     # select the wpay-web project
vercel env add NEXT_PUBLIC_API_URL production
# paste https://wpay-api-six.vercel.app
vercel --prod
```

Repeat for `apps/merchant-dashboard` and `apps/admin-dashboard`.

`NEXT_PUBLIC_STELLAR_NETWORK`, `NEXT_PUBLIC_STELLAR_RPC_URL` and
`NEXT_PUBLIC_CONTRACT_ID` are **not** required. The API builds every
transaction intent with its own `networkPassphrase` and `contractId`, and all
contract/RPC configuration stays server-side. Adding duplicate public values
would risk the browser trusting a different network from the signer.

Do not put `DATABASE_URL`, `JWT_SECRET`, `SOROBAN_SOURCE_SECRET`, Redis
credentials or contract admin keys in Vercel. The frontends never need them.

## 4. Redeploy after changing the URL

`NEXT_PUBLIC_*` values are inlined at build time. After changing
`NEXT_PUBLIC_API_URL`, trigger a new production deployment; an existing build
keeps the old origin. A missing value shows a visible "Backend not configured"
error rather than calling localhost.

## 5. Verify

1. Open the checkout URL with an invoice: `https://wpay-web.vercel.app/?invoice=INV-…`.
2. Open `https://wpay-web.vercel.app/landing` and confirm the landing page
   renders and links back to `/` without replacing checkout.
2. Sign in on the merchant dashboard with an email account or Freighter wallet;
   the onboarding card appears for a wallet with no merchant.
3. Sign in on the admin dashboard with an ADMIN/OPERATOR account.
4. Confirm the browser network tab calls `https://wpay-api-six.vercel.app/v1/...`, not
   `localhost`.
5. Pay a small Testnet invoice end to end. The UI must show the confirmed hash
   only after `/v1/transactions/submit` returns `SUCCESS` and the invoice
   confirmation endpoint returns `PAID`.

AWS/Cloudflare/GitHub Actions deployment is intentionally not triggered from
this repository without credentials.
