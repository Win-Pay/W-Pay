#!/usr/bin/env node
/**
 * End-to-end Stellar Testnet payment against the contracts deployed by
 * scripts/deploy-testnet.cjs:
 *
 *   SAC token -> merchant registration + approval -> payment through
 *   PaymentRouter -> on-chain event + balances + get_payment state.
 *
 * Every value written to deployments/testnet-e2e.json comes from a successful
 * RPC transaction or simulation. Re-running verifies the recorded payment
 * instead of creating a second one.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  Address,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments/testnet.json");
const OUT_FILE = path.join(ROOT, "deployments/testnet-e2e.json");
const SECRET_FILE = path.join(ROOT, ".env.testnet.local");
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const AMOUNT = 10_000_000n; // 1.0 token in stroops
const FEE_BPS = 250;

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envFile() {
  const values = {};
  if (fs.existsSync(SECRET_FILE)) {
    for (const line of fs.readFileSync(SECRET_FILE, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(S[A-Z0-9]+)$/);
      if (match) values[match[1]] = match[2];
    }
  }
  return values;
}

function saveEnv(values) {
  const merged = { ...envFile(), ...values };
  fs.writeFileSync(
    SECRET_FILE,
    Object.entries(merged)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}

const env = envFile();
if (!env.SOROBAN_SOURCE_SECRET) {
  throw new Error("run scripts/deploy-testnet.cjs first (missing SOROBAN_SOURCE_SECRET)");
}
const deployer = Keypair.fromSecret(env.SOROBAN_SOURCE_SECRET);
const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
const contracts = deployments.contracts;
const ids = Object.fromEntries(
  Object.entries(contracts).map(([name, entry]) => [name, entry.contractId]),
);

function keypair(name) {
  const key = `E2E_${name.toUpperCase()}_SECRET`;
  if (env[key]) return Keypair.fromSecret(env[key]);
  const generated = Keypair.random();
  saveEnv({ [key]: generated.secret() });
  env[key] = generated.secret();
  return generated;
}

async function fund(address) {
  try {
    await server.getAccount(address);
    return;
  } catch {
    // not funded
  }
  const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!response.ok) throw new Error(`friendbot failed for ${address}: HTTP ${response.status}`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await server.getAccount(address);
      return;
    } catch {
      await sleep(1500);
    }
  }
  throw new Error(`account ${address} was not funded`);
}

async function send(operation, signers, label) {
  const source = signers[0];
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  for (const signer of signers) prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: rejected (${JSON.stringify(sent.errorResult ?? {})})`);
  }
  let outcome;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1500);
    outcome = await server.getTransaction(sent.hash);
    if (outcome.status !== "NOT_FOUND") break;
  }
  if (!outcome || outcome.status !== "SUCCESS") {
    throw new Error(`${label}: ${sent.hash} ended as ${outcome?.status ?? "UNKNOWN"}`);
  }
  return {
    hash: sent.hash,
    returnValue: outcome.returnValue ? scValToNative(outcome.returnValue) : undefined,
  };
}

function invoke(contract, method, args, signers) {
  return send(
    Operation.invokeContractFunction({ contract, function: method, args }),
    signers,
    `${contract}.${method}`,
  );
}

/** Runs a setup invocation unless simulation says it was already applied. */
async function setup(contract, method, args) {
  try {
    await simulate(contract, method, args);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // AlreadyInitialized=2, InvalidState=8, AlreadyExists=11 in wpay_common.
    if (/AlreadyInitialized|AlreadyExists|InvalidState|Error\(Contract, #(2|8|11)\)/.test(message)) {
      console.log(`== ${method}: already applied (${message})`);
      return null;
    }
    throw error;
  }
  return invoke(contract, method, args, [deployer]);
}

/** Classic operations (trustlines) must go through Horizon, not Soroban RPC. */
async function addTrustline(holder, asset) {
  const horizon = new Horizon.Server(
    process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  );
  const account = await horizon.loadAccount(holder.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();
  tx.sign(holder);
  const response = await horizon.submitTransaction(tx);
  return response.hash;
}

async function simulate(contract, method, args) {
  const account = await server.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: method, args }))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }
  return scValToNative(simulation.result.retval);
}

const call = simulate;

/** Finds the PaymentRouter event for a payment id in recent ledgers. */
async function findPaymentEvent(paymentId) {
  const latest = await server.getLatestLedger();
  for (let span = 1000; span <= 8000; span *= 2) {
    const startLedger = Math.max(1, latest.sequence - span);
    const events = await server.getEvents({
      startLedger,
      endLedger: latest.sequence,
      filters: [{ type: "contract", contractIds: [ids.paymentRouter] }],
      limit: 200,
    });
    const event = events.events.find(
      (candidate) =>
        candidate.topic.length > 1 &&
        scValToNative(candidate.topic[0]) === "payment" &&
        BigInt(scValToNative(candidate.topic[1])) === paymentId,
    );
    if (event) return event;
  }
  return null;
}

const scvAddress = (address) => new Address(address).toScVal();
const roleOperator = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Operator")]);

async function main() {
  const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : null;
  const merchant = keypair("merchant");
  const treasury = keypair("treasury");
  const payer = keypair("payer");

  await fund(deployer.publicKey());
  await fund(payer.publicKey());
  await fund(merchant.publicKey());
  await fund(treasury.publicKey());

  const token = new Asset("WPAYE2E", deployer.publicKey());
  const tokenId = token.contractId(PASSPHRASE);

  if (existing?.payment?.txHash) {
    const outcome = await server.getTransaction(existing.payment.txHash);
    if (outcome.status === "SUCCESS") {
      const state = await call(ids.paymentRouter, "get_payment", [
        xdr.ScVal.scvU64(xdr.Uint64.fromString(existing.payment.id)),
      ]);
      const fee = await call(tokenId, "balance", [scvAddress(treasury.publicKey())]);
      const net = await call(tokenId, "balance", [scvAddress(merchant.publicKey())]);
      console.log(`existing payment ${existing.payment.id} hash ${existing.payment.txHash}`);
      console.log(`transaction ${outcome.status}; on-chain status ${state.status}`);
      console.log(`treasury balance ${fee}, merchant balance ${net}`);
      if (
        outcome.status === "SUCCESS" &&
        BigInt(fee) === BigInt(existing.payment.fee) &&
        BigInt(net) === BigInt(existing.payment.net)
      ) {
        console.log("existing end-to-end payment verified.");
        return;
      }
      throw new Error("existing payment no longer matches the recording");
    }
  }

  // 1. Deploy the asset contract used for the payment and give the recipients
  //    a trustline so the SAC can hold balances for them.
  const assetExists = await server.getContractData(
    tokenId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
    rpc.Durability.Persistent,
  ).catch(() => null);
  let deployTokenTx = "already-deployed";
  if (!assetExists) {
    console.log(`== deploying Stellar Asset Contract for WPAYE2E (${tokenId})`);
    const created = await send(
      Operation.createStellarAssetContract({ asset: token }),
      [deployer],
      "createStellarAssetContract",
    );
    deployTokenTx = created.hash;
  }
  for (const holder of [payer, merchant, treasury]) {
    try {
      await addTrustline(holder, token);
      console.log(`== trustline created for ${holder.publicKey()}`);
    } catch (error) {
      // A re-run keeps the existing trustline.
      const message = String(error instanceof Error ? error.message : error);
      if (!/already exists|op_already_exists|trustline/i.test(message)) throw error;
    }
  }

  const payerBalance = await call(tokenId, "balance", [scvAddress(payer.publicKey())]).catch(
    () => 0n,
  );
  let mint = { hash: null };
  if (payerBalance < AMOUNT) {
    console.log("== minting 100 WPAYE2E to the payer");
    mint = await invoke(
      tokenId,
      "mint",
      [scvAddress(payer.publicKey()), xdr.ScVal.scvI128(new xdr.Int128Parts({
        hi: xdr.Int64.fromString("0"),
        lo: xdr.Uint64.fromString("1000000000"),
      }))],
      [deployer],
    );
  }

  console.log("== initializing FeeManager and MerchantRegistry");
  const feeInit = await setup(
    ids.feeManager,
    "initialize",
    [scvAddress(deployer.publicKey()), scvAddress(treasury.publicKey()), xdr.ScVal.scvU32(FEE_BPS)],
  );
  const registryInit = await setup(ids.merchantRegistry, "initialize", [
    scvAddress(deployer.publicKey()),
  ]);
  const grant = await setup(ids.merchantRegistry, "grant_role", [
    scvAddress(deployer.publicKey()),
    roleOperator,
    scvAddress(deployer.publicKey()),
  ]);

  console.log("== registering and approving the merchant");
  const registered = await setup(ids.merchantRegistry, "register", [
    scvAddress(deployer.publicKey()),
    scvAddress(merchant.publicKey()),
    xdr.ScVal.scvString("E2E Merchant"),
    xdr.ScVal.scvU32(FEE_BPS),
  ]);
  const merchantId = BigInt(await call(ids.merchantRegistry, "count", []));
  const approve = await setup(ids.merchantRegistry, "approve", [
    scvAddress(deployer.publicKey()),
    xdr.ScVal.scvU64(xdr.Uint64.fromString(merchantId.toString())),
  ]);

  console.log("== initializing PaymentRouter");
  const routerInit = await setup(ids.paymentRouter, "initialize", [
    scvAddress(deployer.publicKey()),
    scvAddress(ids.merchantRegistry),
    scvAddress(ids.feeManager),
    scvAddress(treasury.publicKey()),
  ]);

  const expectedFee = (AMOUNT * BigInt(FEE_BPS)) / 10_000n;
  const expectedNet = AMOUNT - expectedFee;
  let paymentId = 1n;
  let paymentHash;
  let ledger;
  const existingState = await call(ids.paymentRouter, "get_payment", [
    xdr.ScVal.scvU64(xdr.Uint64.fromString("1")),
  ]).catch(() => null);

  if (existingState) {
    const event = await findPaymentEvent(1n);
    if (!event) throw new Error("payment 1 exists on chain but its event was not found");
    paymentHash = event.txHash;
    ledger = event.ledger;
    console.log(`== reusing existing payment 1 (${paymentHash})`);
  } else {
    console.log("== submitting the payment");
    const payment = await invoke(
      ids.paymentRouter,
      "create_payment",
      [
        scvAddress(payer.publicKey()),
        xdr.ScVal.scvU64(xdr.Uint64.fromString(merchantId.toString())),
        scvAddress(tokenId),
        xdr.ScVal.scvI128(new xdr.Int128Parts({
          hi: xdr.Int64.fromString("0"),
          lo: xdr.Uint64.fromString(AMOUNT.toString()),
        })),
        xdr.ScVal.scvString("e2e-invoice"),
      ],
      [payer],
    );
    paymentId = BigInt(payment.returnValue);
    paymentHash = payment.hash;
    ledger = (await server.getTransaction(paymentHash)).ledger;
  }

  const state = await call(ids.paymentRouter, "get_payment", [
    xdr.ScVal.scvU64(xdr.Uint64.fromString(paymentId.toString())),
  ]);
  const treasuryBalance = await call(tokenId, "balance", [scvAddress(treasury.publicKey())]);
  const merchantBalance = await call(tokenId, "balance", [scvAddress(merchant.publicKey())]);
  const settled =
    state.status === "Settled" ||
    state.status?.tag === "Settled" ||
    (Array.isArray(state.status) && state.status.includes("Settled"));
  if (!settled) {
    throw new Error(`payment ${paymentId} is not Settled: ${JSON.stringify(state.status)}`);
  }
  if (treasuryBalance !== expectedFee || merchantBalance !== expectedNet) {
    throw new Error(
      `balance mismatch: treasury ${treasuryBalance} (expected ${expectedFee}), merchant ${merchantBalance} (expected ${expectedNet})`,
    );
  }

  console.log("== verifying the PaymentRouter payment event");
  const events = await server.getEvents({
    startLedger: Math.max(1, ledger - 2),
    endLedger: ledger + 2,
    filters: [{ type: "contract", contractIds: [ids.paymentRouter] }],
    limit: 50,
  });
  const event =
    events.events.find(
      (candidate) =>
        candidate.txHash === paymentHash &&
        candidate.topic.length > 1 &&
        scValToNative(candidate.topic[0]) === "payment",
    ) ?? (await findPaymentEvent(paymentId));
  if (!event) throw new Error("PaymentRouter payment event not found for the payment");
  if (event.txHash !== paymentHash) {
    throw new Error(`event tx ${event.txHash} does not match payment tx ${paymentHash}`);
  }
  const eventPaymentId = BigInt(scValToNative(event.topic[1]));
  const [eventPayer, eventMerchant, eventAmount, eventFee] = scValToNative(event.value);
  if (
    eventPaymentId !== paymentId ||
    eventPayer !== payer.publicKey() ||
    BigInt(eventMerchant) !== merchantId ||
    BigInt(eventAmount) !== AMOUNT ||
    BigInt(eventFee) !== expectedFee
  ) {
    throw new Error("payment event does not match the submitted payment");
  }

  const record = {
    network: "testnet",
    rpcUrl: RPC_URL,
    payer: payer.publicKey(),
    merchantSettlement: merchant.publicKey(),
    treasury: treasury.publicKey(),
    tokenContractId: tokenId,
    tokenDeployTxHash: deployTokenTx,
    mintTxHash: mint.hash,
    transactions: {
      feeManagerInitialize: feeInit?.hash ?? null,
      merchantRegistryInitialize: registryInit?.hash ?? null,
      grantOperator: grant?.hash ?? null,
      merchantRegister: registered?.hash ?? null,
      merchantApprove: approve?.hash ?? null,
      paymentRouterInitialize: routerInit?.hash ?? null,
    },
    merchantId: merchantId.toString(),
    payment: {
      id: paymentId.toString(),
      txHash: paymentHash,
      ledger,
      amount: AMOUNT.toString(),
      fee: expectedFee.toString(),
      net: expectedNet.toString(),
      status: "Settled",
      eventVerified: true,
      treasuryBalance: treasuryBalance.toString(),
      merchantBalance: merchantBalance.toString(),
    },
    verifiedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\npayment ${paymentId} settled in ledger ${ledger}`);
  console.log(`fee ${expectedFee} -> treasury, net ${expectedNet} -> merchant`);
  console.log(`event verified; recorded in ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
