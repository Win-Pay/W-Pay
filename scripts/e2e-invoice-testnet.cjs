#!/usr/bin/env node
/**
 * Real Stellar Testnet invoice + settlement flow against an isolated set of
 * contracts deployed by scripts/deploy-testnet.cjs.
 *
 *   merchant registration -> approval -> invoice create -> invoice pay
 *   -> PaymentRouter payment/event/balances -> SettlementManager windows
 *
 * It never reuses or overwrites deployments/testnet.json. Run it with:
 *
 *   DEPLOYMENTS_FILE=deployments/testnet-invoice-deployments.json \
 *   SECRET_FILE=.env.testnet-invoice.local \
 *   CONTRACTS=feeManager,merchantRegistry,paymentRouter,invoiceManager,settlementManager \
 *   node scripts/deploy-testnet.cjs
 *
 *   node scripts/e2e-invoice-testnet.cjs [--skip-negatives|--negatives-only]
 *
 * Every recorded value comes from a successful RPC transaction or simulation.
 * Negative cases are recorded only when the RPC/contract actually rejects them.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  Address,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.resolve(
  ROOT,
  process.env.DEPLOYMENTS_FILE ?? "deployments/testnet-invoice-deployments.json",
);
const OUT_FILE = path.resolve(
  ROOT,
  process.env.EVIDENCE_FILE ?? "deployments/testnet-invoice-e2e.json",
);
const SECRET_FILE = path.resolve(ROOT, process.env.SECRET_FILE ?? ".env.testnet-invoice.local");
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const INVOICE_AMOUNT = 5_000_000n; // 0.5 of a 7-decimal asset
const FEE_BPS = 250;
const MINT_AMOUNT = 100_000_000n;
const UNDERFUNDED_AMOUNT = 1_000_000n;
const REQUIRED = [
  "feeManager",
  "merchantRegistry",
  "paymentRouter",
  "invoiceManager",
  "settlementManager",
];

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);

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
  throw new Error(
    "missing SOROBAN_SOURCE_SECRET; run scripts/deploy-testnet.cjs with SECRET_FILE=.env.testnet-invoice.local first",
  );
}
if (!fs.existsSync(DEPLOYMENTS)) {
  throw new Error(`missing deployment record: ${DEPLOYMENTS}`);
}

const deployer = Keypair.fromSecret(env.SOROBAN_SOURCE_SECRET);
const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
const ids = {};
for (const name of REQUIRED) {
  const id = deployments.contracts?.[name]?.contractId;
  if (!id) throw new Error(`${DEPLOYMENTS} has no contractId for ${name}`);
  ids[name] = id;
}

function keypair(name) {
  const key = `E2E_INVOICE_${name.toUpperCase()}_SECRET`;
  if (env[key]) return Keypair.fromSecret(env[key]);
  const generated = Keypair.random();
  saveEnv({ [key]: generated.secret() });
  env[key] = generated.secret();
  return generated;
}

const merchant = keypair("merchant");
const treasury = keypair("treasury");
const payer = keypair("payer");

async function fund(address) {
  try {
    await server.getAccount(address);
    return;
  } catch {
    // not funded yet
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
    ledger: outcome.ledger,
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

async function simulate(contract, method, args, source = deployer) {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: method, args }))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${contract}.${method} simulation failed: ${simulation.error}`);
  }
  return scValToNative(simulation.result.retval);
}

const call = simulate;

async function setup(contract, method, args, signer = deployer) {
  try {
    await simulate(contract, method, args, signer);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (/AlreadyInitialized|AlreadyExists|InvalidState|Error\(Contract, #(2|8|11)\)/.test(message)) {
      console.log(`== ${method}: already applied (${message})`);
      return null;
    }
    throw error;
  }
  return invoke(contract, method, args, [signer]);
}

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
  return (await horizon.submitTransaction(tx)).hash;
}

const scvAddress = (address) => new Address(address).toScVal();
const scvU64 = (value) => xdr.ScVal.scvU64(xdr.Uint64.fromString(String(value)));
const scvI128 = (value) =>
  xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString(String(value)) }),
  );
const scvString = (value) => xdr.ScVal.scvString(value);
const roleOperator = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Operator")]);

const statusText = (status) => {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    if (typeof status.tag === "string") return status.tag;
    if (typeof status.name === "string") return status.name;
    if (Array.isArray(status) && typeof status[0] === "string") return status[0];
  }
  return String(status);
};

function eventSummary(event) {
  return {
    id: event.id,
    txHash: event.txHash,
    ledger: event.ledger,
    topics: event.topic.map((topic) => scValToNative(topic)),
    value: scValToNative(event.value),
  };
}

async function findEvent(contractId, matches, nearLedger) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const latest = await server.getLatestLedger();
    const ranges = [];
    if (nearLedger) {
      ranges.push([
        Math.max(1, nearLedger - 2),
        Math.min(latest.sequence, nearLedger + 2),
      ]);
    }
    for (let span = 100; span <= 8000; span *= 2) {
      ranges.push([Math.max(1, latest.sequence - span), latest.sequence]);
    }
    for (const [startLedger, endLedger] of ranges) {
      if (startLedger > endLedger) continue;
      let events;
      try {
        events = await server.getEvents({
          startLedger,
          endLedger,
          filters: [{ type: "contract", contractIds: [contractId] }],
          limit: 200,
        });
      } catch {
        continue;
      }
      const event = events.events.find(matches);
      if (event) return event;
    }
    await sleep(2000);
  }
  return null;
}

async function expectSimulationError(label, contract, method, args, source, pattern) {
  try {
    await simulate(contract, method, args, source);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (pattern && !pattern.test(message)) {
      throw new Error(`${label}: rejected with an unexpected error: ${message}`);
    }
    return { test: label, rejected: true, error: message.slice(0, 500) };
  }
  throw new Error(`${label}: expected rejection but simulation succeeded`);
}

function writeEvidence(record) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${json(record)}\n`);
}

function loadEvidence() {
  return fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : null;
}

async function verifyExisting(record) {
  const outcome = await server.getTransaction(record.invoice.paymentTxHash);
  if (outcome.status !== "SUCCESS") throw new Error("recorded invoice payment is no longer successful");
  const invoice = await call(ids.invoiceManager, "get", [scvU64(record.invoice.id)]);
  if (statusText(invoice.status) !== "Paid") throw new Error("recorded invoice is no longer Paid");
  const payment = await call(ids.paymentRouter, "get_payment", [scvU64(record.invoice.paymentId)]);
  if (statusText(payment.status) !== "Settled") throw new Error("recorded payment is no longer Settled");
  if (record.settlement?.windowId) {
    const window = await call(ids.settlementManager, "get_window", [scvU64(record.settlement.windowId)]);
    if (statusText(window.status) !== "Executed") {
      throw new Error("recorded settlement window is no longer Executed");
    }
  }
  console.log(`recorded invoice ${record.invoice.id} and settlement ${record.settlement?.windowId} verified`);
}

async function ensureToken() {
  const token = new Asset("WPAYINV", deployer.publicKey());
  const tokenId = token.contractId(PASSPHRASE);
  const exists = await server
    .getContractData(tokenId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent)
    .catch(() => null);
  let deployTx = "already-deployed";
  if (!exists) {
    console.log(`== deploying SAC for WPAYINV (${tokenId})`);
    deployTx = (
      await send(Operation.createStellarAssetContract({ asset: token }), [deployer], "createSAC")
    ).hash;
  }
  for (const holder of [payer, merchant, treasury]) {
    try {
      await addTrustline(holder, token);
      console.log(`== trustline ready for ${holder.publicKey()}`);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!/already exists|op_already_exists|trustline/i.test(message)) throw error;
    }
  }
  const balance = await call(tokenId, "balance", [scvAddress(payer.publicKey())]).catch(() => 0n);
  let mintTx = null;
  if (BigInt(balance) < MINT_AMOUNT) {
    const missing = MINT_AMOUNT - BigInt(balance);
    console.log(`== minting ${missing} WPAYINV to payer`);
    mintTx = (
      await invoke(tokenId, "mint", [scvAddress(payer.publicKey()), scvI128(missing)], [deployer])
    ).hash;
  }
  return { token, tokenId, deployTx, mintTx };
}

async function ensureMerchant() {
  let merchantId = await call(ids.merchantRegistry, "merchant_of", [
    scvAddress(merchant.publicKey()),
  ]);
  let registerTx = null;
  if (!merchantId) {
    console.log("== registering merchant");
    const registered = await invoke(
      ids.merchantRegistry,
      "register",
      [scvAddress(merchant.publicKey()), scvAddress(merchant.publicKey()), scvString("Testnet Invoice Merchant"), xdr.ScVal.scvU32(FEE_BPS)],
      [merchant],
    );
    registerTx = registered.hash;
    merchantId = await call(ids.merchantRegistry, "merchant_of", [
      scvAddress(merchant.publicKey()),
    ]);
    if (!merchantId) throw new Error(`registration ${registered.hash} produced no merchant id`);
  }
  const active = await call(ids.merchantRegistry, "is_active", [scvU64(merchantId)]);
  let approveTx = null;
  if (!active) {
    console.log(`== approving merchant ${merchantId}`);
    approveTx = (
      await invoke(ids.merchantRegistry, "approve", [scvAddress(deployer.publicKey()), scvU64(merchantId)], [deployer])
    ).hash;
  }
  return { id: BigInt(merchantId), registerTx, approveTx };
}

async function createAndPayInvoice(tokenId, merchantId, record) {
  const now = Math.floor(Date.now() / 1000);
  const dueAt = now + 3600;
  const memo = `invoice-${now}`;
  let invoiceId = record?.invoice?.id ? BigInt(record.invoice.id) : null;
  let createTx = record?.invoice?.createTxHash ?? null;
  let createLedger = record?.invoice?.createLedger ?? null;

  if (invoiceId) {
    const invoice = await call(ids.invoiceManager, "get", [scvU64(invoiceId)]).catch(() => null);
    if (!invoice) invoiceId = null;
    else if (statusText(invoice.status) === "Paid") {
      return {
        invoiceId,
        memo: record.invoice.memo,
        dueAt: Number(record.invoice.dueAt),
        createTx,
        createLedger,
        paymentTx: record.invoice.paymentTxHash,
        paymentLedger: record.invoice.paymentLedger,
        paymentId: BigInt(record.invoice.paymentId),
        resumed: true,
      };
    } else if (statusText(invoice.status) === "Open") {
      memo = String(invoice.memo);
      dueAt = Number(invoice.due_at);
    } else {
      invoiceId = null;
    }
  }

  if (!invoiceId) {
    console.log("== creating invoice");
    const created = await invoke(
      ids.invoiceManager,
      "create",
      [
        scvAddress(merchant.publicKey()),
        scvU64(merchantId),
        scvAddress(tokenId),
        scvI128(INVOICE_AMOUNT),
        scvU64(dueAt),
        scvString(memo),
      ],
      [merchant],
    );
    invoiceId = BigInt(created.returnValue);
    createTx = created.hash;
    createLedger = created.ledger;
  }

  console.log(`== paying invoice ${invoiceId}`);
  const paid = await invoke(ids.invoiceManager, "pay", [scvAddress(payer.publicKey()), scvU64(invoiceId)], [payer]);
  return {
    invoiceId,
    memo,
    dueAt,
    createTx,
    createLedger,
    paymentTx: paid.hash,
    paymentLedger: paid.ledger,
    paymentId: BigInt(paid.returnValue),
    resumed: false,
  };
}

async function verifyInvoice(invoiceId, paymentId, memo, tokenId, merchantId, before) {
  const invoice = await call(ids.invoiceManager, "get", [scvU64(invoiceId)]);
  const payment = await call(ids.paymentRouter, "get_payment", [scvU64(paymentId)]);
  const treasuryBalance = BigInt(await call(tokenId, "balance", [scvAddress(treasury.publicKey())]));
  const merchantBalance = BigInt(await call(tokenId, "balance", [scvAddress(merchant.publicKey())]));
  const payerBalance = BigInt(await call(tokenId, "balance", [scvAddress(payer.publicKey())]));

  const expectedFee = (INVOICE_AMOUNT * BigInt(FEE_BPS)) / 10_000n;
  const expectedNet = INVOICE_AMOUNT - expectedFee;
  if (statusText(invoice.status) !== "Paid") throw new Error(`invoice is ${statusText(invoice.status)}`);
  if (BigInt(invoice.payment_id) !== BigInt(paymentId)) throw new Error("invoice payment id mismatch");
  if (statusText(payment.status) !== "Settled") throw new Error(`payment is ${statusText(payment.status)}`);
  if (BigInt(payment.amount) !== INVOICE_AMOUNT) throw new Error("payment amount mismatch");
  if (BigInt(payment.fee) !== expectedFee) throw new Error("payment fee mismatch");
  if (BigInt(payment.net) !== expectedNet) throw new Error("payment net mismatch");
  if (BigInt(payment.merchant_id) !== BigInt(merchantId)) throw new Error("payment merchant mismatch");
  if (String(payment.memo) !== memo) throw new Error("payment memo does not match the invoice memo");
  if (treasuryBalance - before.treasury !== expectedFee) throw new Error("treasury balance delta mismatch");
  if (merchantBalance - before.merchant !== expectedNet) throw new Error("merchant balance delta mismatch");
  if (before.payer - payerBalance !== INVOICE_AMOUNT) throw new Error("payer balance delta mismatch");

  return {
    invoice: {
      id: String(invoiceId),
      merchantId: String(merchantId),
      memo: String(payment.memo),
      amount: String(INVOICE_AMOUNT),
      fee: String(expectedFee),
      net: String(expectedNet),
      status: statusText(invoice.status),
      paymentId: String(paymentId),
      paymentStatus: statusText(payment.status),
    },
    balances: {
      payerBefore: String(before.payer),
      payerAfter: String(payerBalance),
      treasuryBefore: String(before.treasury),
      treasuryAfter: String(treasuryBalance),
      merchantBefore: String(before.merchant),
      merchantAfter: String(merchantBalance),
    },
  };
}

async function verifyEvents(invoiceId, paymentId, paymentTx, nearLedger) {
  const invoiceEvent = await findEvent(
    ids.invoiceManager,
    (candidate) => {
      if (scValToNative(candidate.topic[0]) !== "invoice") return false;
      return BigInt(scValToNative(candidate.topic[1])) === BigInt(invoiceId);
    },
    nearLedger,
  );
  if (!invoiceEvent) throw new Error("invoice event not found");
  const paidEvent = await findEvent(
    ids.invoiceManager,
    (candidate) => {
      if (scValToNative(candidate.topic[0]) !== "paid") return false;
      return BigInt(scValToNative(candidate.topic[1])) === BigInt(invoiceId);
    },
    nearLedger,
  );
  if (!paidEvent) throw new Error("invoice paid event not found");
  if (paidEvent.txHash !== paymentTx) throw new Error("invoice paid event tx mismatch");
  const paymentEvent = await findEvent(
    ids.paymentRouter,
    (candidate) => {
      if (candidate.txHash !== paymentTx) return false;
      return scValToNative(candidate.topic[0]) === "payment";
    },
    nearLedger,
  );
  if (!paymentEvent) throw new Error("PaymentRouter payment event not found");
  if (BigInt(scValToNative(paymentEvent.topic[1])) !== BigInt(paymentId)) {
    throw new Error("PaymentRouter event payment id mismatch");
  }
  const paidValue = scValToNative(paidEvent.value);
  if (BigInt(paidValue[1]) !== BigInt(paymentId)) throw new Error("paid event payment id mismatch");
  return {
    invoice: eventSummary(invoiceEvent),
    paid: eventSummary(paidEvent),
    payment: eventSummary(paymentEvent),
  };
}

async function runSettlement(tokenId) {
  const now = Math.floor(Date.now() / 1000);
  const fee = (INVOICE_AMOUNT * BigInt(FEE_BPS)) / 10_000n;
  const net = INVOICE_AMOUNT - fee;

  console.log("== opening funded settlement window");
  const opened = await invoke(
    ids.settlementManager,
    "open_window",
    [scvAddress(deployer.publicKey()), scvAddress(tokenId), scvU64(now - 600), scvU64(now + 600)],
    [deployer],
  );
  const windowId = BigInt(opened.returnValue);
  const entry = await invoke(
    ids.settlementManager,
    "add_entry",
    [scvAddress(deployer.publicKey()), scvU64(windowId), scvAddress(merchant.publicKey()), scvI128(net)],
    [deployer],
  );
  const closed = await invoke(
    ids.settlementManager,
    "close_window",
    [scvAddress(deployer.publicKey()), scvU64(windowId)],
    [deployer],
  );
  const merchantBefore = BigInt(await call(tokenId, "balance", [scvAddress(merchant.publicKey())]));
  const fundedFirst = await invoke(
    ids.settlementManager,
    "fund",
    [scvAddress(payer.publicKey()), scvAddress(tokenId), scvI128(net)],
    [payer],
  );
  const executed = await invoke(
    ids.settlementManager,
    "execute",
    [scvAddress(deployer.publicKey()), scvU64(windowId)],
    [deployer],
  );
  const merchantAfter = BigInt(await call(tokenId, "balance", [scvAddress(merchant.publicKey())]));
  const window = await call(ids.settlementManager, "get_window", [scvU64(windowId)]);
  const pool = BigInt(await call(ids.settlementManager, "pool", [scvAddress(tokenId)]));
  if (statusText(window.status) !== "Executed") throw new Error("settlement window is not Executed");
  if (merchantAfter - merchantBefore !== net) throw new Error("settlement merchant delta mismatch");
  if (pool !== 0n) throw new Error(`settlement pool should be zero, got ${pool}`);

  const executeEvent = await findEvent(
    ids.settlementManager,
    (candidate) => {
      if (candidate.txHash !== executed.hash) return false;
      return scValToNative(candidate.topic[0]) === "execute";
    },
    executed.ledger,
  );
  if (!executeEvent) throw new Error("settlement execute event not found");

  console.log("== proving an underfunded window is rejected atomically");
  const secondOpen = await invoke(
    ids.settlementManager,
    "open_window",
    [scvAddress(deployer.publicKey()), scvAddress(tokenId), scvU64(now + 700), scvU64(now + 1300)],
    [deployer],
  );
  const secondId = BigInt(secondOpen.returnValue);
  await invoke(
    ids.settlementManager,
    "add_entry",
    [scvAddress(deployer.publicKey()), scvU64(secondId), scvAddress(merchant.publicKey()), scvI128(UNDERFUNDED_AMOUNT)],
    [deployer],
  );
  const secondClosed = await invoke(
    ids.settlementManager,
    "close_window",
    [scvAddress(deployer.publicKey()), scvU64(secondId)],
    [deployer],
  );
  const underfunded = await expectSimulationError(
    "underfunded settlement execution",
    ids.settlementManager,
    "execute",
    [scvAddress(deployer.publicKey()), scvU64(secondId)],
    deployer,
    /InsufficientFunds|#7/,
  );
  const balanceAfterRejection = BigInt(await call(tokenId, "balance", [scvAddress(merchant.publicKey())]));
  if (balanceAfterRejection !== merchantAfter) throw new Error("rejected settlement changed merchant balance");
  const fundedSecond = await invoke(
    ids.settlementManager,
    "fund",
    [scvAddress(payer.publicKey()), scvAddress(tokenId), scvI128(UNDERFUNDED_AMOUNT)],
    [payer],
  );
  const secondExecuted = await invoke(
    ids.settlementManager,
    "execute",
    [scvAddress(deployer.publicKey()), scvU64(secondId)],
    [deployer],
  );
  const secondState = await call(ids.settlementManager, "get_window", [scvU64(secondId)]);
  if (statusText(secondState.status) !== "Executed") throw new Error("funded retry did not execute");
  const duplicate = await expectSimulationError(
    "duplicate settlement execution",
    ids.settlementManager,
    "execute",
    [scvAddress(deployer.publicKey()), scvU64(secondId)],
    deployer,
    /InvalidState|#8/,
  );

  return {
    windowId: String(windowId),
    status: statusText(window.status),
    total: String(net),
    txHashes: {
      open: opened.hash,
      entry: entry.hash,
      close: closed.hash,
      fund: fundedFirst.hash,
      execute: executed.hash,
    },
    ledgers: {
      open: opened.ledger,
      entry: entry.ledger,
      close: closed.ledger,
      fund: fundedFirst.ledger,
      execute: executed.ledger,
    },
    merchantBefore: String(merchantBefore),
    merchantAfter: String(merchantAfter),
    poolAfter: String(pool),
    event: eventSummary(executeEvent),
    atomicRetry: {
      windowId: String(secondId),
      closeTx: secondClosed.hash,
      underfunded,
      fundedTx: fundedSecond.hash,
      executeTx: secondExecuted.hash,
      status: statusText(secondState.status),
      duplicateRejected: duplicate,
    },
    automationPoolFunding: null,
  };
}

async function fundAutomationPool(tokenId) {
  const fee = (INVOICE_AMOUNT * BigInt(FEE_BPS)) / 10_000n;
  const net = INVOICE_AMOUNT - fee;
  console.log("== pre-funding the settlement pool for the automatic executor");
  const funded = await invoke(
    ids.settlementManager,
    "fund",
    [scvAddress(payer.publicKey()), scvAddress(tokenId), scvI128(net)],
    [payer],
  );
  const pool = BigInt(await call(ids.settlementManager, "pool", [scvAddress(tokenId)]));
  if (pool !== net) throw new Error(`automation pool is ${pool}, expected ${net}`);
  return { txHash: funded.hash, ledger: funded.ledger, amount: String(net), pool: String(pool) };
}

async function runNegatives(invoiceId, paymentId, tokenId, merchantId) {
  console.log("== negative cases");
  const results = [];
  results.push(
    await expectSimulationError(
      "duplicate invoice payment",
      ids.invoiceManager,
      "pay",
      [scvAddress(payer.publicKey()), scvU64(invoiceId)],
      payer,
      /InvalidState|#8/,
    ),
  );
  results.push(
    await expectSimulationError(
      "non-owner invoice creation",
      ids.invoiceManager,
      "create",
      [
        scvAddress(payer.publicKey()),
        scvU64(merchantId),
        scvAddress(tokenId),
        scvI128(INVOICE_AMOUNT),
        scvU64(Math.floor(Date.now() / 1000) + 3600),
        scvString("not-the-owner"),
      ],
      payer,
      /Unauthorized|#3/,
    ),
  );

  const bogusToken = StrKey.encodeContract(crypto.randomBytes(32));
  console.log("== creating an invoice with an unsupported token");
  const bogus = await invoke(
    ids.invoiceManager,
    "create",
    [
      scvAddress(merchant.publicKey()),
      scvU64(merchantId),
      scvAddress(bogusToken),
      scvI128(UNDERFUNDED_AMOUNT),
      scvU64(Math.floor(Date.now() / 1000) + 3600),
      scvString("unsupported-token"),
    ],
    [merchant],
  );
  const bogusInvoiceId = BigInt(bogus.returnValue);
  results.push(
    await expectSimulationError(
      "unsupported token payment",
      ids.invoiceManager,
      "pay",
      [scvAddress(payer.publicKey()), scvU64(bogusInvoiceId)],
      payer,
      null,
    ),
  );
  await invoke(
    ids.invoiceManager,
    "cancel",
    [scvAddress(merchant.publicKey()), scvU64(bogusInvoiceId)],
    [merchant],
  );

  const expiredDue = Math.floor(Date.now() / 1000) + 8;
  console.log("== creating an invoice that expires before payment");
  const expiring = await invoke(
    ids.invoiceManager,
    "create",
    [
      scvAddress(merchant.publicKey()),
      scvU64(merchantId),
      scvAddress(tokenId),
      scvI128(UNDERFUNDED_AMOUNT),
      scvU64(expiredDue),
      scvString("expired-invoice"),
    ],
    [merchant],
  );
  const expiredId = BigInt(expiring.returnValue);
  const waitMs = Math.max(0, (expiredDue + 3) * 1000 - Date.now());
  console.log(`== waiting ${Math.ceil(waitMs / 1000)}s for invoice ${expiredId} to expire`);
  await sleep(waitMs);
  results.push(
    await expectSimulationError(
      "expired invoice payment",
      ids.invoiceManager,
      "pay",
      [scvAddress(payer.publicKey()), scvU64(expiredId)],
      payer,
      /Expired|#9/,
    ),
  );
  const marked = await invoke(ids.invoiceManager, "mark_expired", [scvU64(expiredId)], [deployer]);
  const expiredState = await call(ids.invoiceManager, "get", [scvU64(expiredId)]);
  if (statusText(expiredState.status) !== "Expired") throw new Error("invoice was not marked Expired");

  results.push({
    test: "wrong amount",
    rejected: null,
    notApplicable: "InvoiceManager.pay consumes the invoice's stored amount; the caller cannot supply an amount.",
  });
  results.push({
    test: "invalid transaction hash / replay",
    rejected: null,
    notApplicable:
      "The invoice API takes no transaction hash. Replay of the same payment is covered by the duplicate-payment rejection.",
  });
  results.push({
    test: "wrong invoice reference",
    rejected: null,
    notApplicable:
      "The contract treats the memo as opaque text and pays the invoice id supplied; it cannot validate an off-chain reference.",
  });

  return {
    results,
    unsupportedTokenInvoice: {
      id: String(bogusInvoiceId),
      token: bogusToken,
      createTx: bogus.hash,
      status: "Cancelled",
    },
    expiredInvoice: {
      id: String(expiredId),
      dueAt: expiredDue,
      createTx: expiring.hash,
      markExpiredTx: marked.hash,
      status: statusText(expiredState.status),
    },
  };
}

async function main() {
  const mode = process.argv.includes("--negatives-only")
    ? "negatives"
    : process.argv.includes("--skip-negatives")
      ? "positives"
      : "full";
  let record = loadEvidence();

  if (mode !== "negatives" && record?.invoice?.paymentTxHash) {
    await verifyExisting(record);
    console.log(`evidence is complete: ${path.relative(ROOT, OUT_FILE)}`);
    return;
  }

  for (const account of [deployer, payer, merchant, treasury]) await fund(account.publicKey());

  const token = await ensureToken();
  const tokenId = token.tokenId;

  console.log("== initializing isolated contracts");
  const hashes = {};
  hashes.feeManager = (
    await setup(ids.feeManager, "initialize", [
      scvAddress(deployer.publicKey()),
      scvAddress(treasury.publicKey()),
      xdr.ScVal.scvU32(FEE_BPS),
    ])
  )?.hash;
  hashes.merchantRegistry = (
    await setup(ids.merchantRegistry, "initialize", [scvAddress(deployer.publicKey())])
  )?.hash;
  await setup(ids.merchantRegistry, "grant_role", [
    scvAddress(deployer.publicKey()),
    roleOperator,
    scvAddress(deployer.publicKey()),
  ]);
  hashes.paymentRouter = (
    await setup(ids.paymentRouter, "initialize", [
      scvAddress(deployer.publicKey()),
      scvAddress(ids.merchantRegistry),
      scvAddress(ids.feeManager),
      scvAddress(treasury.publicKey()),
    ])
  )?.hash;
  hashes.invoiceManager = (
    await setup(ids.invoiceManager, "initialize", [
      scvAddress(deployer.publicKey()),
      scvAddress(ids.paymentRouter),
      scvAddress(ids.merchantRegistry),
    ])
  )?.hash;
  hashes.settlementManager = (
    await setup(ids.settlementManager, "initialize", [scvAddress(deployer.publicKey())])
  )?.hash;
  await setup(ids.settlementManager, "grant_role", [
    scvAddress(deployer.publicKey()),
    roleOperator,
    scvAddress(deployer.publicKey()),
  ]);

  const merchantRecord = await ensureMerchant();
  const merchantId = merchantRecord.id;
  const before = {
    treasury: BigInt(await call(tokenId, "balance", [scvAddress(treasury.publicKey())])),
    merchant: BigInt(await call(tokenId, "balance", [scvAddress(merchant.publicKey())])),
    payer: BigInt(await call(tokenId, "balance", [scvAddress(payer.publicKey())])),
  };

  if (mode === "negatives") {
    if (!record?.invoice?.id || !record?.invoice?.paymentId) {
      throw new Error("--negatives-only needs a completed invoice in the evidence file");
    }
    record.negativeTests = await runNegatives(
      BigInt(record.invoice.id),
      BigInt(record.invoice.paymentId),
      record.token.contractId,
      BigInt(record.merchant.id),
    );
    record.negativesVerifiedAt = new Date().toISOString();
    writeEvidence(record);
    console.log(`negative cases recorded in ${path.relative(ROOT, OUT_FILE)}`);
    return;
  }

  const invoice = await createAndPayInvoice(tokenId, merchantId, record);
  const invoiceState = await verifyInvoice(
    invoice.invoiceId,
    invoice.paymentId,
    invoice.memo,
    tokenId,
    merchantId,
    before,
  );
  const events = await verifyEvents(
    invoice.invoiceId,
    invoice.paymentId,
    invoice.paymentTx,
    invoice.paymentLedger,
  );

  const settlement = await runSettlement(tokenId);
  const automation = await fundAutomationPool(tokenId);

  record = {
    network: "testnet",
    rpcUrl: RPC_URL,
    deployer: deployer.publicKey(),
    contracts: ids,
    deploymentRecord: path.relative(ROOT, DEPLOYMENTS),
    token: {
      assetCode: "WPAYINV",
      issuer: deployer.publicKey(),
      contractId: tokenId,
      deployTxHash: token.deployTx,
      mintTxHash: token.mintTx,
    },
    merchant: {
      id: String(merchantId),
      owner: merchant.publicKey(),
      settlement: merchant.publicKey(),
      registerTx: merchantRecord.registerTx,
      approvalTx: merchantRecord.approveTx,
    },
    initializeTxHashes: hashes,
    invoice: {
      id: String(invoice.invoiceId),
      memo: invoice.memo,
      amount: invoiceState.invoice.amount,
      fee: invoiceState.invoice.fee,
      net: invoiceState.invoice.net,
      dueAt: String(invoice.dueAt),
      createTxHash: invoice.createTx,
      createLedger: invoice.createLedger,
      paymentTxHash: invoice.paymentTx,
      paymentLedger: invoice.paymentLedger,
      paymentId: String(invoice.paymentId),
      status: invoiceState.invoice.status,
      paymentStatus: invoiceState.invoice.paymentStatus,
      balances: invoiceState.balances,
    },
    events,
    settlement,
    automationPoolFunding: automation,
    negativeTests: null,
    verifiedAt: new Date().toISOString(),
  };

  writeEvidence(record);
  console.log(`\ninvoice ${invoice.invoiceId} paid by ${invoice.paymentTx}`);
  console.log(`settlement window ${settlement.windowId} executed by ${settlement.txHashes.execute}`);
  console.log(`recorded in ${path.relative(ROOT, OUT_FILE)}`);

  if (mode === "full") {
    record.negativeTests = await runNegatives(
      invoice.invoiceId,
      invoice.paymentId,
      tokenId,
      merchantId,
    );
    record.negativesVerifiedAt = new Date().toISOString();
    writeEvidence(record);
    console.log("negative cases recorded");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
