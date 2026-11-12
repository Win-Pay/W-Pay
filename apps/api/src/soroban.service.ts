import { Inject, Injectable, Logger } from "@nestjs/common";
import { SorobanGateway, calls, keypairSigner, type WalletSigner } from "@wpay/sdk";
import type { TransactionIntent } from "@wpay/types";
import { APP_CONFIG, type AppConfig } from "./config";

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
