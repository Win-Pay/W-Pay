# Deployments

## Current status

**All 16 contracts are deployed to Stellar Testnet and an end-to-end payment
has settled on-chain.** The API, Postgres, Redis and indexer are not hosted;
they run locally/compose only. The three frontends are static Vercel hosting and
read `NEXT_PUBLIC_API_URL` at build time, so they show a configuration error
until that variable points at a deployed backend.

| Component | Status | Evidence |
| --- | --- | --- |
| Contracts | **deployed on Testnet** | 16/16 ids and transactions below; deployed 2026-11-12; instances and create txs re-checked over RPC 2026-11-13 |
| End-to-end payment | **verified on Testnet** | tx `db354f7f…e47d`, ledger 5698164, event + balances checked |
| API payment confirmation | **verified locally against Testnet** | payment `SETTLED`, `contractPaymentId=1`, fee/net `250000`/`9750000`; see the invoice-memo qualification below |
| API | not hosted | runs locally against Postgres/Redis; no public URL |
| Indexer | not hosted | runs locally; no public URL |
| Checkout UI | deployed (frontend only) | <https://wpay-web.vercel.app> — HTTP 200 verified 2026-11-12 |
| Merchant dashboard | deployed (frontend only) | <https://wpay-merchant.vercel.app> — HTTP 200 verified 2026-11-12 |
| Admin dashboard | deployed (frontend only) | <https://wpay-admin.vercel.app> — HTTP 200 verified 2026-11-12 |

The frontend bundles contain `NEXT_PUBLIC_API_URL` only when it is set at Vercel
build time. Production builds no longer fall back to `localhost`; a missing URL
renders a visible configuration error instead of pretending to call an API.
Backend deployment and the exact Vercel values are documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[docs/VERCEL.md](docs/VERCEL.md).

### Frontend deployment record

| Host | Project | URL | Deployed | Verified |
| --- | --- | --- | --- | --- |
| Vercel (team `w-pay`) | `wpay-web` | https://wpay-web.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Checkout</title>` |
| Vercel (team `w-pay`) | `wpay-merchant` | https://wpay-merchant.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Merchant</title>` |
| Vercel (team `w-pay`) | `wpay-admin` | https://wpay-admin.vercel.app | 2026-11-12 | `GET /` → 200, `<title>W-Pay Admin</title>` |

## Stellar Testnet contract deployment (verified)

- Network: `testnet` (passphrase `Test SDF Network ; September 2015`)
- RPC: <https://soroban-testnet.stellar.org>
- Deployer: `GC62GMOO5V4YHGP5UFJRO6E44ND4VTWFHK3Y4DISP5H33AQHKIS7GBIY`
  (throwaway friendbot-funded key; **not** multisig, **not** for production)
- Deployed: 2026-11-12T20:08:25Z
- Record: [`deployments/testnet.json`](deployments/testnet.json)
- Every `upload` and `create` transaction returned `SUCCESS`; each id below was
  read back with `getContractData(..., LedgerKeyContractInstance)`.
- Every recorded WASM hash matches the local `wasm32v1-none` release artifact
  byte-for-byte (16/16 re-verified on 2026-11-12).

| Contract | Contract id | Upload tx | Create tx | WASM sha256 |
| --- | --- | --- | --- | --- |
| paymentRouter | `CDKHZJ2PHJZ5VLS4AXJK3BYJ244XYEAFE23NLJ6YA7Q76RKSE4IREGHP` | `06251d75f096560eff322b3857e2dc11043a6a100e72fbde5493b34497c80cd0` | `65c42d5601a435597fad49dfbab6a45a31782529a44c8f14265fa4742dc91457` | `26028f4f5363f978883954e9c3c0bc7577158eb56a00941f0f41f19b1cb11412` |
| invoiceManager | `CDAAHUVJU2I5REE7EFMADE2WN2ZO7MIN6AZON436FXZOLUONDHGRCMUP` | `a79ac4ca8ef1e36362acb719ceea5c0fdb8618098ba67c045a4513b82d7635f1` | `fe5eb1c8a30ad5df2910e034d13f2a0423156445d058dfe1708caf3f1927a294` | `85e636ca08b27470eca815696086daa954115401d9e2b345b0d74b2e9acf4cf3` |
| escrowManager | `CDJUBZ75USVXHMAF66TBN23EOFZG2VIWQ6W3Z77VI4Z2JKQH3PJDCMJK` | `00adeaeabd2d73f53cec2159b1b92cbbd0c843a6e3985e2e8aeec31aa22ca34a` | `79a851ff61bf7496852b2de84e6abfef566f280372f9cd955dd309563da34732` | `f4b96de5cc89238f0a3befe368d6866379be563b4b39db28a174059f27c6cf7a` |
| refundManager | `CA7QDH52TBH3SEFZ77UARMPQITKSQBOIBP54WEKCP3USUEKLNEFH2WZU` | `d1ca68a16525dbd6a6138543859ccad984e8deded98d6ecc6a36420087ec8c00` | `230755d1ed977d02c87e7ed43511f53228490e0ca39d67f6364a012bb2d3dffc` | `42685c376a3497203bce862bed046ea0c7ce8904b18c30ef5135efef0a716114` |
| subscriptionManager | `CC4QH7OWO63FPRHTSB2OY4KMF3L7OOQWJEC7NDOUKZUIT3AD65KK3CSK` | `71ad2ad4efac40b3fe5450774b55db29af7388efab3dd8b9e9ee252a509bf337` | `ef78e4936a7eb0e00173a805f6b8c173cda2f7b69871745bdc6f5acc2990886b` | `c8101e4ccb14c841fec040cc96fc799a6c377346e201337d6b16723880c8194b` |
| settlementManager | `CA2WESKQCLRUGQOIO4GTBHHSNQSDYMV7CUFNTCNQ2HCZHX5TP3OVQLOE` | `04936a4066207ab38cdca9a446a60cb647cb6d211b7be9f5ca3a8e01f471aa76` | `aa13169f3dd924cb61fe5291313162aecc72e37b857122e6f3de6ec9faaf7d7c` | `a4900184f94ae5bad709f68f72cfcda82dea70212ecfb74526aa28392f5e604a` |
| merchantRegistry | `CBGOI75MKNJ7HDSYNWKRIDY7ESRRZDYHFGUESMKWZGJJCCY3EGIBLBZG` | `ddd8018968dfca5760fbd6c5ef0ff76db5e7c73e67062dbcc7aaf60221cbfdc1` | `d24479cba61d8bbd3e39284691ef81d73c79575540d8700f48f48942b5ea32dc` | `bbf99ed98b476186a3a04064cd575a62a60fb553b67c361d91bdd5725f42c80d` |
| treasuryVault | `CC2V7N74QEVEA3RZIDNSCSGNV26BFSHW666QU73IDIKROOAMYAIDEMYX` | `4f22436a2b6f15e73167b629a449a124939626b122f832d00c415c98aa919c6b` | `e0827c9a82b9027119937d2c7c57be6a63265222a137b6df6a2bd8a45bb2a681` | `04f3e1944027a6d79215945842b9f88a48aaaf97fe0811d9c4f93ee720b28a8f` |
| feeManager | `CDHLJ7E4XEOIBZROZ2F5F22TAHLTKRWK2CMTF7BK7ZRZRMR7E3A42W6J` | `832d47ec0e6f1aba5e3dd9d19e6def9feeedffd28e4e30771f2c0a7de927c71e` | `833d86f8e75a4e296f6978534030081b4beb2eb3b18ea62faebaf33f344a684d` | `f48e82e992663198e4e24101ac93fcfc072b6dd09b16de48bc119bfe4bc1aca8` |
| configurationManager | `CDIXKCZPSMK43LSDDTGMDW75KIKNCU4AMQEYVG6CJM535LLRKOB3CESE` | `aa05e7d7901c18a1285669a13cdc94c05fea5638ae31f8f427289ccc8bab1dd2` | `6a0889b5c4fa05f023c1bfe5c8780a324b145e62ca37b720a23b488fdd7efa97` | `5fd15d16c78a022133eb3d047b3132568882de819b52f53ee7e2e3266f7555e1` |
| emergencyPause | `CAHAMOC2QYSHO3NBYRNQJRYV5B3Y7FL2H3X6L3DY5U3HQEMLO2HELH73` | `1f164271159d46df7bfa61a9bec22fab35508e9b4ed188cfb6e0e8b53f251c45` | `2db661d706b2f74eb9307735c69b0ed1548f3b7d56666c482a6c6fdbafd4205c` | `59c566d263b75ff792fbf01ee28d7d2410e36f972a67f96496fe250d3c19ebd5` |
| roleManager | `CB37C5KBPP7NUVG27ZTXDLLBCNF46J6M6I4BCUMCIW4RDNZLJBMBQMYA` | `bed7ba38b31151dbaa66dee45e2a29ec19bde3883f48d567288b91e31bae6d55` | `c563f34ed6f1a9750a48397a4b63cc8c39240d0cf9d24aa80459c6d45337abe3` | `fe718ef24b7c892a0e7e941194333d544a58567eb090ad679ab83acc84e86cd1` |
| upgradeManager | `CCFL5PAAOEMPLBM36AJZUU5XTJDP6ZVVCWVUJJ7MP426DRSIYAF3UGRZ` | `75122464ba19ce5e8d83d4af6e5d7836c7eaf84ad649d3a4800ae8898ab691a8` | `af5bedf5428e3a0806aab895a77761969e6d02f449250826b4062d9be1046352` | `4b12257448b945df6f432b6dc897d09bba473a9eed12e6f65ba2842d3ccbd8bc` |
| priceOracle | `CBLXT3XSTQVYRDXSTSA4TX2EWFZVONLMFL2O3VFAUZVDQCF2FZ3KEIFX` | `bfa47bbb103cff18ea60f201b962668920454bca88a7416b53b6374181f8f97d` | `cbf312f666b4957869c250b804278c350bc54d4b541d2d9a81cc6dfa55c643d0` | `ea0a7c79e8d0de97ebba9d003f3935dd130f5ae22ae5b15548d5a5abccceb5e7` |
| governance | `CCDCKGQ6UKATVSS337GLN5TNKCK2O2EUABOK6RO3UD2CN254E6P2TW4Z` | `23deb6bf57980c0c22969f0316bb816ff84bd672348c2b2695b0af7b3fc0afcf` | `f677ec7a79aae0c03e118324aff26ba90b43b18ea8b953d697063a8d1abd72db` | `a20f7dee963f70ee499d1420bd6c8d10c4e33c7607a179c50dccd13c64bc67cc` |
| impactNft | `CCDFZQWPOHTWOHVWUHCYI2RCBYUJNFSZCRRHEYE5PB26YKDEIOILM5SJ` | `e5265f08e24dc22a3583aeddc6f17eb7f6fa4221916cf05811eda861dfc8e1f4` | `556218142eb968673ce644e29638f82b93ce148937a4ad1e099ff567ec06085f` | `09596d1aca78517f7041f166c646b09d027cced02effb54829b4bdd4427b23f0` |

> The table above is generated from `deployments/testnet.json`. Do not hand-edit
> ids or hashes; re-run `node scripts/deploy-testnet.cjs` to verify or resume.

## End-to-end Testnet payment (verified)

`scripts/e2e-testnet.cjs` deploys a Stellar Asset Contract for the test asset,
creates trustlines through Horizon, mints test tokens, initialises FeeManager,
MerchantRegistry and PaymentRouter, registers and approves a merchant, then pays
an invoice through `PaymentRouter`.

| Field | Value |
| --- | --- |
| Payment id | `1` |
| Transaction | `db354f7f04a6703b66f37a916c6e4994a017dd45c3689923e43cd9476257e47d` |
| Ledger | `5698164` |
| Amount | `10000000` stroops (1.0 token) |
| Fee / net | `250000` / `9750000` (250 bps) |
| Payer | `GC3AOR6HUH7VEVPGPQVSI3MI6EQTPD3WZQ2BLGJ7KUIF7C42YM5T6ATZ` |
| Merchant settlement | `GD6ZGJBQWVZXA652ORVM4NPOISP2HV3G2GFNO5PWLVQFGN3WQYG4UYLD` |
| Treasury | `GDUCNJFS3ATDWJWPWOVVUOMO6CWD4I6TXVJV7AAC52VAZOZQYTRFMXF4` |
| Token (SAC) | `CDCYAJJ3PEE5ZHCL5QZJTQPV27EDJTM2AALPUWTSS743VPH5ZQLOKRKW` |
| Record | [`deployments/testnet-e2e.json`](deployments/testnet-e2e.json) |

The script verified: transaction `SUCCESS`, `get_payment(1)` reports `Settled`,
treasury balance is exactly `250000`, merchant balance is exactly `9750000`,
and the `payment` contract event carries the same payer, merchant id, amount
and fee. Re-running the script verifies the recorded payment instead of
creating a second one.

### Testnet resource measurement

`pnpm measure:testnet` reads the record above, checks it over RPC/Horizon and
simulates a fresh `create_payment` with the public payer account. It loads no
secret and submits nothing. Measured 2026-11-12:

| Metric | Value |
| --- | --- |
| Recorded fee charged | 82,589 stroops |
| Recorded envelope / result / meta | 1,896 / 64 / 8,036 bytes |
| Simulated CPU instructions | 2,419,372 |
| Simulated disk read / write bytes | 372 / 1,532 |
| Simulated minimum resource fee | 83,770 stroops |
| Unsigned / assembled envelope | 308 / 1,840 bytes |
| Assembled fee field | 83,870 stroops |

The simulated fee differs from the recorded fee because the footprint and auth
entries depend on current ledger state. These are Testnet measurements, not a
mainnet price guarantee.

### API confirmation (real network, real database)

The running API was pointed at the Testnet contracts and the recorded payment
was confirmed through `POST /v1/payments/:id/confirm` (and the corresponding
invoice path):

- payment → `SETTLED`, `contractPaymentId=1`, fee `250000`,
  `txHash=db354f7f…e47d`
- Negative checks: a nonexistent hash returns `400 transaction is not
  successful (NOT_FOUND)`; the real hash with a non-matching amount returns
  `400 transaction does not match this invoice`; the invoice stays `OPEN`.

**Invoice-memo qualification (2026-11-13):** the historical confirmation used
tx `db354f7f…e47d`, whose memo is `e2e-invoice`, while invoice
`INV-202611-E09CA2` expects its invoice number as the memo. Verification now
binds the invocation memo to the invoice number, so this historical transaction
does not pass current invoice-level verification. It remains valid evidence that
the payment settled on-chain and that the API verifies contract arguments and
events; a fresh invoice payment must be made to demonstrate the memo-binding
path end to end.

This confirms the API does not mark a payment successful without on-chain
verification. It does not claim the hosted checkout is live: the API and
indexer are still local-only.

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
