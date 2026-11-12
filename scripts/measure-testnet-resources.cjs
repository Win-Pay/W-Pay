#!/usr/bin/env node
/**
 * Reads the recorded Testnet payment, then simulates a new `create_payment`
 * with the recorded payer as source account. No key is loaded, nothing is
 * signed, and nothing is submitted: this measures the network's resource
 * estimate and the envelope the wallet would be asked to sign.
 *
 * Run with the API's installed SDK:
 *   NODE_PATH=apps/api/node_modules node scripts/measure-testnet-resources.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} = require("@stellar/stellar-sdk");

const ROOT = path.resolve(__dirname, "..");
const NETWORK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/testnet.json"), "utf8"));
const E2E = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/testnet-e2e.json"), "utf8"));
const RPC_URL = process.env.STELLAR_RPC_URL ?? NETWORK.rpcUrl;
const PASSPHRASE = Networks.TESTNET;
const server = new rpc.Server(RPC_URL);

function xdrBytes(value) {
  return Buffer.from(value, "base64").length;
}

async function main() {
  const render = await server.getLatestLedger();
  console.log(`rpc=${RPC_URL} network=${NETWORK.network} latest_ledger=${render.sequence}`);

  const recordedHash = E2E.payment.txHash;
  const recorded = await server.getTransaction(recordedHash);
  if (recorded.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`recorded payment ${recordedHash} is not SUCCESS: ${recorded.status}`);
  }
  const horizon = await fetch(`https://horizon-testnet.stellar.org/transactions/${recordedHash}`);
  if (!horizon.ok) throw new Error(`Horizon lookup failed: ${horizon.status}`);
  const horizonTx = await horizon.json();
  console.log(
    `recorded_payment hash=${recordedHash} ledger=${recorded.ledger} ` +
      `fee_charged_stroops=${horizonTx.fee_charged} envelope_bytes=${xdrBytes(recorded.envelopeXdr.toXDR("base64"))} ` +
      `result_bytes=${xdrBytes(recorded.resultXdr.toXDR("base64"))} ` +
      `result_meta_bytes=${xdrBytes(recorded.resultMetaXdr.toXDR("base64"))}`,
  );

  const payer = E2E.payer;
  const account = await server.getAccount(payer);
  const router = NETWORK.contracts.paymentRouter.contractId;
  const merchantId = BigInt(E2E.merchantId);
  const token = E2E.tokenContractId;
  const call = new Contract(router).call(
    "create_payment",
    nativeToScVal(Address.fromString(payer)),
    nativeToScVal(merchantId, { type: "u64" }),
    nativeToScVal(Address.fromString(token)),
    nativeToScVal(1000n, { type: "i128" }),
    nativeToScVal("resource-benchmark"),
  );
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(call)
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`simulation failed: ${simulation.error}`);
  }
  const resources = simulation.transactionData.build().resources();
  const assembled = rpc
    .assembleTransaction(transaction, simulation)
    .build();
  console.log(
    `simulated_payment.create cpu_instructions=${resources.instructions()} ` +
      `disk_read_bytes=${resources.diskReadBytes()} write_bytes=${resources.writeBytes()} ` +
      `min_resource_fee_stroops=${simulation.minResourceFee} ` +
      `unsigned_envelope_bytes=${xdrBytes(transaction.toEnvelope().toXDR("base64"))} ` +
      `assembled_envelope_bytes=${xdrBytes(assembled.toEnvelope().toXDR("base64"))} ` +
      `assembled_fee_stroops=${assembled.fee}`,
  );
}

main().catch((error) => {
  console.error(`resource measurement failed: ${error.message}`);
  process.exitCode = 1;
});
