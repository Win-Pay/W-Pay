# Key management and production authority

This is a design and ceremony runbook, not evidence that a multisig, HSM or
mainnet deployment exists. Nothing here has been executed on Mainnet.

## Current state

- All 16 contracts are on Testnet with a single throwaway, Friendbot-funded
  deployer/admin key. It must never be reused for production.
- The API can hold `SOROBAN_SOURCE_SECRET` for automated operator flows. That is
  a single hot key in an environment variable and is only suitable for Testnet.
- `ADMIN_ADDRESSES` is an API allowlist; it does not itself protect contract
  admin calls. The contract sees the signing address, so production admin
  authority must be an account the operator cannot unilaterally spend from.

## Target design

### 1. Admin account: 2-of-3 Stellar multisig

Use a dedicated Stellar account as the admin address for every contract. It does
not hold customer funds; it holds only the minimum XLM balance and signs admin
operations.

| Signer | Medium | Weight |
| --- | --- | --- |
| Operations lead | Hardware wallet (Ledger) | 1 |
| Security lead | Hardware wallet, separate location | 1 |
| Recovery key | Offline seed/HSM in a safe | 1 |
| Master key | Disabled (`weight 0`) after setup | 0 |
| Account threshold | `low=2, med=2, high=2` | — |

A 2-of-3 threshold means one compromised or lost device cannot move admin
authority. The master key must be set to weight 0 only after the three signers
are verified with a test transaction.

### 2. Contract admin transfer

Contracts store an `Address` admin. Transfer it to the multisig account, not to
a personal key:

1. Deploy and initialize with a temporary deployer only if necessary.
2. Set roles (`role-manager`) and ownership/admin fields to the multisig.
3. Verify each admin getter returns the multisig address.
4. Renounce/disable the deployer key's admin role.
5. Record the transfer transaction hash per contract.

Because Stellar multisig is account-level, a contract call signed by the
multisig account requires the configured quorum; separate holders sign the same
transaction envelope. Confirm the exact CLI/wallet signing flow with the chosen
hardware wallets before the ceremony.

### 3. Timelocks and separation of powers

- `upgrade-manager` enforces a delay between proposal and execution. Bounds are
  `MIN_DELAY_SECS = 3_600` (1 hour) and `MAX_DELAY_SECS = 2_592_000` (30 days).
  Set production delay to at least 48–72 hours; the deployment script's default
  is only a test value.
- `governance` allows member proposals, one vote per member, quorum on yes votes
  and a strict majority over no votes. It does not execute actions itself;
  `mark_executed` is an explicit admin call. Combine it with the upgrade delay,
  not as a replacement for it.
- `emergency-pause` is a fast, narrow power (pause/unpause). It should be held by
  a separate 2-of-3 or 2-of-4 ops account so an upgrade signer cannot silently
  pause payments.
- Fee changes are capped on-chain. Use a separate fee-operator role from the
  upgrade admin where the contracts allow it.

### 4. HSM / signer service

For any automated signing (settlement execution, oracle updates):

- Do not put a production seed in a plain environment variable.
- Prefer an HSM/YubiHSM 2 or a signer service holding an Ed25519 key, exposing a
  narrow "sign this exact operation" API with policy limits and audit logs.
- If the API must sign, give it a dedicated operator key with the minimum role
  and balance, never the multisig admin key.
- Rotate the operator key on a schedule and after any suspicion; record the old
  public key and rotation transaction.

### 5. API and session keys

- `JWT_SECRET` is a symmetric signing key. Generate 32 random bytes, store it in
  a secret manager, rotate on a schedule, and accept a short overlap window only
  if token invalidation is acceptable.
- Access and CSRF tokens are held in memory only. The rotating refresh token is
  an `HttpOnly`, `Secure` cookie scoped to `/v1/auth` and is never readable from
  JavaScript; refresh and logout require a matching `x-csrf-token` header.
  `SameSite` defaults to `None` in production (cross-site frontends) and can be
  set to `Lax` with a first-party `COOKIE_DOMAIN`. Because cross-site cookies
  depend on browser third-party-cookie policy, a first-party cookie domain is
  preferred.
- API keys are hashed at rest and scoped; rotate by creating a new key, deploying
  it, then revoking the old one. Never log the plaintext.
- The browser extension requests only the configured API origin, at lookup time,
  through `optional_host_permissions`; it no longer asks for `https://*/*` at
  install.

## Ceremony checklist (not yet performed)

- [ ] Generate three signer keys on separate hardware devices; record public
      keys and backups; never print seeds or photograph them.
- [ ] Fund the multisig account; set signer weights and thresholds; verify with a
      low-value test transaction from the multisig.
- [ ] Transfer each contract's admin/role to the multisig; verify getters;
      disable the deployer's authority.
- [ ] Configure upgrade delay to the production value; configure governance
      voting period/quorum and record them.
- [ ] Deploy the API/indexer with no admin key in the environment; use a
      dedicated operator signer service if automatic signing is required.
- [ ] Record every transaction hash and configuration value in a signed ceremony
      report; have two people verify it.
- [ ] Test key loss and recovery on Testnet before Mainnet: one signer lost, one
      signer compromised, and a cancelled upgrade proposal.

## Residual risks

- A 2-of-3 multisig still depends on operational discipline; collusion of two
  holders is enough.
- Hardware wallet support for Soroban auth entries must be verified for the exact
  wallet/firmware used; a browser extension is not an HSM.
- Timelock values protect only actions routed through the upgrade manager; direct
  admin setters still need multisig custody.
- No independent audit has reviewed this design.
