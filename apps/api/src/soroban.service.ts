import { Inject, Injectable, Logger } from "@nestjs/common";
import { Address, Transaction, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { SorobanGateway, calls, keypairSigner, type WalletSigner } from "@wpay/sdk";
import type { TransactionIntent } from "@wpay/types";
import { APP_CONFIG, type AppConfig } from "./config";

export interface VerifiedPayment {
  txHash: string;
  ledger: number;
  contractPaymentId: bigint;
  payer: string;
  merchantId: bigint;
  token: string;
  amount: bigint;
  fee: bigint;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds unsigned Soroban transactions for client wallets.
 *
 * Nothing here fakes a submission: when the required contracts are not
 * configured the method returns `null` and the API records the request as
 * pending. `submit` only returns after the network reports a final status.
 */
@Injectable()
export class SorobanService {
  private readonly logger = new Logger("soroban");
  readonly gateway: SorobanGateway;
  readonly configured: boolean;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.gateway = new SorobanGateway({
      rpcUrl: this.config.env.STELLAR_RPC_URL ?? this.config.network.rpcUrl,
      networkPassphrase: this.config.network.networkPassphrase,
      contracts: this.config.contracts,
    });
    this.configured = Boolean(this.config.contracts.paymentRouter);
    if (!this.configured) {
      this.logger.warn(
        "no CONTRACT_PAYMENT_ROUTER_ID set: payment intents will be recorded without an on-chain transaction",
      );
    }
  }

  has(name: Parameters<SorobanGateway["hasContract"]>[0]): boolean {
    return this.gateway.hasContract(name);
  }

  /** Signer for automated flows (settlement execution, keeper charges). */
  operatorSigner(): WalletSigner | null {
    if (!this.config.sorobanSourceSecret) return null;
    return keypairSigner(
      this.config.sorobanSourceSecret,
      this.config.network.networkPassphrase,
    );
  }

  private async intent(
    contract: Parameters<SorobanGateway["hasContract"]>[0],
    source: string,
    call: { method: string; args: ReturnType<typeof calls.createPayment>["args"] },
    description: string,
  ): Promise<TransactionIntent | null> {
    if (!this.gateway.hasContract(contract)) return null;
    try {
      const transaction = await this.gateway.prepareInvocation({
        contract,
        method: call.method,
        args: call.args,
        source,
      });
      return {
        xdr: transaction.toXDR(),
        networkPassphrase: this.config.network.networkPassphrase,
        contractId: this.gateway.contractId(contract),
        method: call.method,
        description,
      };
    } catch (error) {
      this.logger.error(
        `failed to build ${contract}.${call.method}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  paymentIntent(input: {
    payer: string;
    merchantId: bigint;
    token: string;
    amount: bigint;
    memo: string;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "paymentRouter",
      input.payer,
      calls.createPayment(input),
      "Pay merchant through PaymentRouter",
    );
  }

  invoiceIntent(input: {
    owner: string;
    merchantId: bigint;
    token: string;
    amount: bigint;
    dueAt: number;
    memo: string;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "invoiceManager",
      input.owner,
      calls.createInvoice(input),
      "Create invoice on chain",
    );
  }

  escrowIntent(input: {
    payer: string;
    payee: string;
    arbiter: string;
    token: string;
    amount: bigint;
    releaseAt: number;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "escrowManager",
      input.payer,
      calls.createEscrow(input),
      "Fund escrow",
    );
  }

  releaseEscrowIntent(caller: string, escrowId: bigint): Promise<TransactionIntent | null> {
    return this.intent("escrowManager", caller, calls.releaseEscrow(caller, escrowId), "Release escrow");
  }

  resolveEscrowIntent(
    arbiter: string,
    escrowId: bigint,
    releaseToPayee: boolean,
  ): Promise<TransactionIntent | null> {
    return this.intent(
      "escrowManager",
      arbiter,
      calls.resolveEscrow(arbiter, escrowId, releaseToPayee),
      "Resolve escrow dispute",
    );
  }

  createPlanIntent(input: {
    owner: string;
    merchantId: bigint;
    token: string;
    amount: bigint;
    intervalSecs: number;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "subscriptionManager",
      input.owner,
      calls.createPlan(input),
      "Create subscription plan",
    );
  }

  refundEscrowIntent(caller: string, escrowId: bigint): Promise<TransactionIntent | null> {
    return this.intent("escrowManager", caller, calls.refundEscrow(caller, escrowId), "Refund escrow");
  }

  disputeEscrowIntent(caller: string, escrowId: bigint): Promise<TransactionIntent | null> {
    return this.intent("escrowManager", caller, calls.disputeEscrow(caller, escrowId), "Dispute escrow");
  }

  approveRefundIntent(settlement: string, refundId: bigint): Promise<TransactionIntent | null> {
    return this.intent(
      "refundManager",
      settlement,
      calls.approveRefund(settlement, refundId),
      "Approve refund",
    );
  }

  subscribeIntent(input: {
    subscriber: string;
    planId: bigint;
    cycles: number;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "subscriptionManager",
      input.subscriber,
      calls.subscribe(input),
      "Subscribe (prepaid cycles)",
    );
  }

  cancelSubscriptionIntent(subscriber: string, subscriptionId: bigint): Promise<TransactionIntent | null> {
    return this.intent(
      "subscriptionManager",
      subscriber,
      calls.cancelSubscription(subscriber, subscriptionId),
      "Cancel subscription",
    );
  }

  approveMerchantIntent(operator: string, merchantId: bigint): Promise<TransactionIntent | null> {
    return this.intent(
      "merchantRegistry",
      operator,
      calls.approveMerchant(operator, merchantId),
      "Approve merchant on chain",
    );
  }

  suspendMerchantIntent(operator: string, merchantId: bigint): Promise<TransactionIntent | null> {
    return this.intent(
      "merchantRegistry",
      operator,
      calls.suspendMerchant(operator, merchantId),
      "Suspend merchant on chain",
    );
  }

  pauseAllIntent(admin: string): Promise<TransactionIntent | null> {
    return this.intent("emergencyPause", admin, calls.pauseAll(admin), "Pause all contracts");
  }

  unpauseAllIntent(admin: string): Promise<TransactionIntent | null> {
    return this.intent("emergencyPause", admin, calls.unpauseAll(admin), "Unpause all contracts");
  }

  withdrawIntent(input: {
    admin: string;
    token: string;
    to: string;
    amount: bigint;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "treasuryVault",
      input.admin,
      calls.withdrawTreasury(input),
      "Withdraw from treasury",
    );
  }

  requestRefundIntent(input: {
    payer: string;
    paymentId: bigint;
    amount: bigint;
    reason: string;
  }): Promise<TransactionIntent | null> {
    return this.intent(
      "refundManager",
      input.payer,
      calls.requestRefund(input),
      "Request refund on chain",
    );
  }

  /**
   * Verifies that a successful transaction is exactly the payment this API
   * expects: the PaymentRouter invocation args must match, and the PaymentRouter
   * `payment` event in the same transaction must match the invocation and the
   * caller's expected values. Returns null instead of guessing.
   */
  async verifyPaymentTransaction(
    txHash: string,
    ledger: number,
    expected?: { payer: string; merchantId: bigint; token: string; amount: bigint },
  ): Promise<VerifiedPayment | null> {
    if (!this.has("paymentRouter")) return null;
    const contractId = this.gateway.contractId("paymentRouter");

    const response = await this.gateway.server.getTransaction(txHash);
    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;
    if (!("envelopeXdr" in response) || !response.envelopeXdr) return null;

    const transaction = TransactionBuilder.fromXDR(
      response.envelopeXdr,
      this.config.network.networkPassphrase,
    );
    if (!(transaction instanceof Transaction)) return null;
    const operation = transaction.operations.find((entry) => entry.type === "invokeHostFunction");
    if (!operation || operation.type !== "invokeHostFunction") return null;

    const invocation = operation.func.invokeContract();
    if (Address.fromScAddress(invocation.contractAddress()).toString() !== contractId) return null;
    if (invocation.functionName().toString() !== "create_payment") return null;

    const args = invocation.args().map((arg) => scValToNative(arg));
    const [argPayer, argMerchant, argToken, argAmount] = args;
    const payerArg = typeof argPayer === "string" ? argPayer : null;
    const merchantArg = toBigInt(argMerchant);
    const tokenArg = typeof argToken === "string" ? argToken : null;
    const amountArg = toBigInt(argAmount);
    if (!payerArg || merchantArg === null || !tokenArg || amountArg === null) return null;

    if (
      expected &&
      (payerArg !== expected.payer ||
        merchantArg !== expected.merchantId ||
        tokenArg !== expected.token ||
        amountArg !== expected.amount)
    ) {
      return null;
    }

    const isPaymentEvent = (candidate: rpc.Api.EventResponse): boolean => {
      const kindTopic = candidate.topic[0];
      return (
        candidate.txHash === txHash &&
        candidate.topic.length > 1 &&
        kindTopic !== undefined &&
        scValToNative(kindTopic) === "payment"
      );
    };

    let eventResponse: rpc.Api.GetEventsResponse | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      eventResponse = await this.gateway.server.getEvents({
        startLedger: ledger,
        // Some RPC providers return no events for an exact single-ledger range.
        endLedger: ledger + 5,
        filters: [{ type: "contract", contractIds: [contractId] }],
        limit: 200,
      });
      if ((eventResponse.events ?? []).some(isPaymentEvent)) break;
      await sleep(500);
    }

    const event = (eventResponse?.events ?? []).find(isPaymentEvent);
    if (!event) return null;

    const paymentIdTopic = event.topic[1];
    if (paymentIdTopic === undefined) return null;
    const contractPaymentId = toBigInt(scValToNative(paymentIdTopic));
    const data = scValToNative(event.value);
    if (contractPaymentId === null || !Array.isArray(data)) return null;
    const [eventPayer, eventMerchant, eventAmount, eventFee] = data;
    const payer = typeof eventPayer === "string" ? eventPayer : null;
    const merchantId = toBigInt(eventMerchant);
    const amount = toBigInt(eventAmount);
    const fee = toBigInt(eventFee);
    if (!payer || merchantId === null || amount === null || fee === null) return null;

    if (
      payer !== payerArg ||
      merchantId !== merchantArg ||
      amount !== amountArg ||
      (expected && (payer !== expected.payer || merchantId !== expected.merchantId || amount !== expected.amount))
    ) {
      return null;
    }

    return {
      txHash,
      ledger,
      contractPaymentId,
      payer,
      merchantId,
      token: tokenArg,
      amount,
      fee,
    };
  }

  /** Submits a wallet-signed XDR and waits for the final ledger status. */
  async submit(signedXdr: string): Promise<{
    hash: string;
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
    ledger?: number;
    returnValue?: unknown;
  }> {
    const submitted = await this.gateway.submit(signedXdr);
    const outcome = await this.gateway.awaitTransaction(submitted.hash, 60_000);
    return {
      hash: submitted.hash,
      status: outcome.status,
      ledger: "ledger" in outcome ? outcome.ledger : undefined,
      returnValue: outcome.status === "SUCCESS" ? outcome.returnValue : undefined,
    };
  }
}
