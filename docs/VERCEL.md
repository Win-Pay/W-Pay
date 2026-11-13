# Vercel frontend configuration

The three customer-facing projects are independent Next.js deployments in the
same pnpm workspace:

| Vercel project | Local app | Production URL |
| --- | --- | --- |
| `wpay-web` | `apps/web` | https://wpay-web.vercel.app |
| `wpay-merchant` | `apps/merchant-dashboard` | https://wpay-merchant.vercel.app |
| `wpay-admin` | `apps/admin-dashboard` | https://wpay-admin.vercel.app |

They are currently frontend-only deployments. No Vercel token or backend host
was available in this workspace, so linking the projects to a live API was not
performed. The configuration below is ready to apply.

## 1. Deploy the backend first

The browser apps need a public HTTPS API origin. Follow
[DEPLOYMENT.md](DEPLOYMENT.md) (Compose or Kubernetes). The API must allow all
three production origins:

```env
WEB_PUBLIC_URL=https://wpay-web.vercel.app
CORS_ORIGINS=https://wpay-web.vercel.app,https://wpay-merchant.vercel.app,https://wpay-admin.vercel.app
```

Verify before touching Vercel:

```bash
curl -s https://api.example.com/v1/health
# {"status":"ok","database":"up","soroban":"up",...}
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/docs   # 200
```

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
| `NEXT_PUBLIC_API_URL` | `https://api.example.com` (your real API origin) | Production, Preview, Development |

Set it per project:

```bash
cd apps/web
vercel link                     # select the wpay-web project
vercel env add NEXT_PUBLIC_API_URL production
# paste https://api.example.com
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
2. Sign in on the merchant dashboard with an email account or Freighter wallet;
   the onboarding card appears for a wallet with no merchant.
3. Sign in on the admin dashboard with an ADMIN/OPERATOR account.
4. Confirm the browser network tab calls `https://api.example.com/v1/...`, not
   `localhost`.
5. Pay a small Testnet invoice end to end. The UI must show the confirmed hash
   only after `/v1/transactions/submit` returns `SUCCESS` and the invoice
   confirmation endpoint returns `PAID`.

AWS/Cloudflare/GitHub Actions deployment is intentionally not triggered from
this repository without credentials.
