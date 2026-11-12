#!/usr/bin/env node
/**
 * Deploys the compiled Soroban contracts to Stellar Testnet and writes the
 * verified contract ids / transaction hashes to deployments/testnet.json.
 *
 * Credentials: SOROBAN_SOURCE_SECRET from the environment or .env.testnet.local
 * (git-ignored). When absent, a throwaway keypair is generated and funded with
 * Friendbot; its secret is written to .env.testnet.local only.
 *
 * Nothing is recorded unless the RPC reports SUCCESS and returns the contract
 * address. Re-running with the same file resumes: already recorded contracts
 * are verified against the network and skipped.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
} = require("@stellar/stellar-sdk");

const ROOT = path.resolve(__dirname, "..");
const WASM_DIR = path.join(ROOT, "packages/contracts/target/wasm32v1-none/release");
const OUT_FILE = path.join(ROOT, "deployments/testnet.json");
const SECRET_FILE = path.join(ROOT, ".env.testnet.local");
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const CONTRACTS = [
  ["paymentRouter", "wpay_payment_router"],
  ["invoiceManager", "wpay_invoice_manager"],
  ["escrowManager", "wpay_escrow_manager"],
  ["refundManager", "wpay_refund_manager"],
  ["subscriptionManager", "wpay_subscription_manager"],
  ["settlementManager", "wpay_settlement_manager"],
  ["merchantRegistry", "wpay_merchant_registry"],
  ["treasuryVault", "wpay_treasury_vault"],
  ["feeManager", "wpay_fee_manager"],
  ["configurationManager", "wpay_configuration_manager"],
  ["emergencyPause", "wpay_emergency_pause"],
  ["roleManager", "wpay_role_manager"],
  ["upgradeManager", "wpay_upgrade_manager"],
  ["priceOracle", "wpay_price_oracle"],
  ["governance", "wpay_governance"],
  ["impactNft", "wpay_impact_nft"],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadSecret() {
  if (process.env.SOROBAN_SOURCE_SECRET) return process.env.SOROBAN_SOURCE_SECRET.trim();
  if (fs.existsSync(SECRET_FILE)) {
    const match = fs.readFileSync(SECRET_FILE, "utf8").match(/^SOROBAN_SOURCE_SECRET=(S[A-Z0-9]+)$/m);
    if (match) return match[1];
  }
  return null;
}

async function fundWithFriendbot(address) {
  const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!response.ok && response.status !== 400) {
    throw new Error(`friendbot failed: HTTP ${response.status}`);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const account = await server.getAccount(address);
      if (account) return;
    } catch {
      // not funded yet
    }
    await sleep(1500);
  }
  throw new Error("account was not funded by friendbot");
}

const server = new rpc.Server(RPC_URL);

async function submit(operation, label) {
  const account = await server.getAccount(keypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: submission rejected (${JSON.stringify(sent.errorResult ?? {})})`);
  }
  let outcome;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1500);
    outcome = await server.getTransaction(sent.hash);
    if (outcome.status !== "NOT_FOUND") break;
  }
  if (!outcome || outcome.status !== "SUCCESS") {
    throw new Error(`${label}: transaction ${sent.hash} ended as ${outcome?.status ?? "UNKNOWN"}`);
  }
  return {
    hash: sent.hash,
    returnValue: outcome.returnValue ? scValToNative(outcome.returnValue) : undefined,
  };
}

let keypair;

async function main() {
  const secret = loadSecret();
  if (secret) {
    keypair = Keypair.fromSecret(secret);
    console.log(`deployer: ${keypair.publicKey()} (existing secret)`);
    await fundWithFriendbot(keypair.publicKey()).catch(() => {});
  } else {
    keypair = Keypair.random();
    console.log(`deployer: ${keypair.publicKey()} (new throwaway key)`);
    await fundWithFriendbot(keypair.publicKey());
    fs.writeFileSync(SECRET_FILE, `SOROBAN_SOURCE_SECRET=${keypair.secret()}\n`, { mode: 0o600 });
    console.log(`secret saved to ${path.relative(ROOT, SECRET_FILE)} (git-ignored)`);
  }

  const existing = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8"))
    : { network: "testnet", rpcUrl: RPC_URL, deployedAt: null, deployer: null, contracts: {} };
  existing.network = "testnet";
  existing.rpcUrl = RPC_URL;
  existing.deployer = keypair.publicKey();
  existing.deployedAt = existing.deployedAt ?? new Date().toISOString();
  existing.contracts = existing.contracts ?? {};

  for (const [name, crate] of CONTRACTS) {
    const wasmPath = path.join(WASM_DIR, `${crate}.wasm`);
    if (!fs.existsSync(wasmPath)) throw new Error(`missing wasm: ${wasmPath}`);
    const wasm = fs.readFileSync(wasmPath);
    const wasmSha256 = crypto.createHash("sha256").update(wasm).digest("hex");
    const previous = existing.contracts[name];
    if (previous?.contractId) {
      const onChain = await server.getContractData(
        previous.contractId,
        require("@stellar/stellar-sdk").xdr.ScVal.scvLedgerKeyContractInstance(),
        rpc.Durability.Persistent,
      ).catch(() => null);
      if (onChain) {
        console.log(`== ${name}: already deployed ${previous.contractId}, skipping`);
        continue;
      }
    }

    console.log(`== ${name}: uploading ${crate}.wasm (${wasmSha256})`);
    const upload = await submit(Operation.uploadContractWasm({ wasm }), `${name}.upload`);
    const create = await submit(
      Operation.createCustomContract({
        address: new Address(keypair.publicKey()),
        wasmHash: Buffer.from(wasmSha256, "hex"),
        salt: crypto.randomBytes(32),
      }),
      `${name}.create`,
    );
    const contractId = typeof create.returnValue === "string" ? create.returnValue : null;
    if (!contractId || !contractId.startsWith("C")) {
      throw new Error(`${name}: create transaction ${create.hash} returned no contract id`);
    }
    existing.contracts[name] = {
      contractId,
      wasmSha256,
      uploadTxHash: upload.hash,
      createTxHash: create.hash,
      deployedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(existing, null, 2)}\n`);
    console.log(`   contract ${contractId} (deploy tx ${create.hash})`);
  }

  const count = Object.values(existing.contracts).filter((entry) => entry.contractId).length;
  console.log(`\n${count}/${CONTRACTS.length} contracts deployed on testnet.`);
  console.log(`recorded in ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
