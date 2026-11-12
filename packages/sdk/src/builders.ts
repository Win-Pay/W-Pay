/**
 * Contract call descriptors. They are pure data so they can be unit tested and
 * reused by scripts without a network connection.
 */
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractName } from "@wpay/config";
import { scv } from "./soroban";

export interface ContractCall {
  contract: ContractName;
  method: string;
  args: xdr.ScVal[];
}

export const calls = {
  /** PaymentRouter.create_payment(payer, merchant_id, token, amount, memo) */
  createPayment(input: {
    payer: string;
    merchantId: bigint | number;
    token: string;
    amount: bigint;
    memo: string;
  }): ContractCall {
    return {
      contract: "paymentRouter",
      method: "create_payment",
      args: [
        scv.address(input.payer),
        scv.u64(input.merchantId),
        scv.address(input.token),
        scv.i128(input.amount),
        scv.string(input.memo),
      ],
    };
  },

  /** InvoiceManager.create(owner, merchant_id, token, amount, due_at, memo) */
  createInvoice(input: {
    owner: string;
    merchantId: bigint | number;
    token: string;
    amount: bigint;
    dueAt: number;
    memo: string;
  }): ContractCall {
    return {
      contract: "invoiceManager",
      method: "create",
      args: [
        scv.address(input.owner),
        scv.u64(input.merchantId),
        scv.address(input.token),
        scv.i128(input.amount),
        scv.u64(input.dueAt),
        scv.string(input.memo),
      ],
    };
  },

  /** InvoiceManager.pay(payer, invoice_id) */
  payInvoice(input: { payer: string; invoiceId: bigint | number }): ContractCall {
    return {
      contract: "invoiceManager",
      method: "pay",
      args: [scv.address(input.payer), scv.u64(input.invoiceId)],
    };
  },

  /** EscrowManager.create(payer, payee, arbiter, token, amount, release_at) */
  createEscrow(input: {
    payer: string;
    payee: string;
    arbiter: string;
    token: string;
    amount: bigint;
    releaseAt: number;
  }): ContractCall {
    return {
      contract: "escrowManager",
      method: "create",
      args: [
        scv.address(input.payer),
        scv.address(input.payee),
        scv.address(input.arbiter),
        scv.address(input.token),
        scv.i128(input.amount),
        scv.u64(input.releaseAt),
      ],
    };
  },

  releaseEscrow(caller: string, escrowId: bigint | number): ContractCall {
    return {
      contract: "escrowManager",
      method: "release",
      args: [scv.address(caller), scv.u64(escrowId)],
    };
  },

  refundEscrow(caller: string, escrowId: bigint | number): ContractCall {
    return {
      contract: "escrowManager",
      method: "refund",
      args: [scv.address(caller), scv.u64(escrowId)],
    };
  },

  disputeEscrow(caller: string, escrowId: bigint | number): ContractCall {
    return {
      contract: "escrowManager",
      method: "dispute",
      args: [scv.address(caller), scv.u64(escrowId)],
    };
  },

  resolveEscrow(arbiter: string, escrowId: bigint | number, releaseToPayee: boolean): ContractCall {
    return {
      contract: "escrowManager",
      method: "resolve",
      args: [scv.address(arbiter), scv.u64(escrowId), scv.bool(releaseToPayee)],
    };
  },

  /** RefundManager.request(payer, payment_id, amount, reason) */
  requestRefund(input: {
    payer: string;
    paymentId: bigint | number;
    amount: bigint;
    reason: string;
  }): ContractCall {
    return {
      contract: "refundManager",
      method: "request",
      args: [
        scv.address(input.payer),
        scv.u64(input.paymentId),
        scv.i128(input.amount),
        scv.string(input.reason),
      ],
    };
  },

  /** RefundManager.approve(settlement, refund_id) — signed by the settlement wallet. */
  approveRefund(settlement: string, refundId: bigint | number): ContractCall {
    return {
      contract: "refundManager",
      method: "approve",
      args: [scv.address(settlement), scv.u64(refundId)],
    };
  },

  rejectRefund(settlement: string, refundId: bigint | number, reason: string): ContractCall {
    return {
      contract: "refundManager",
      method: "reject",
      args: [scv.address(settlement), scv.u64(refundId), scv.string(reason)],
    };
  },

  /** SubscriptionManager.create_plan(owner, merchant_id, token, amount, interval_secs) */
  createPlan(input: {
    owner: string;
    merchantId: bigint | number;
    token: string;
    amount: bigint;
    intervalSecs: number;
  }): ContractCall {
    return {
      contract: "subscriptionManager",
      method: "create_plan",
      args: [
        scv.address(input.owner),
        scv.u64(input.merchantId),
        scv.address(input.token),
        scv.i128(input.amount),
        scv.u64(input.intervalSecs),
      ],
    };
  },

  /** SubscriptionManager.subscribe(subscriber, plan_id, cycles) */
  subscribe(input: { subscriber: string; planId: bigint | number; cycles: number }): ContractCall {
    return {
      contract: "subscriptionManager",
      method: "subscribe",
      args: [scv.address(input.subscriber), scv.u64(input.planId), scv.u32(input.cycles)],
    };
  },

  chargeSubscription(subscriptionId: bigint | number): ContractCall {
    return {
      contract: "subscriptionManager",
      method: "charge",
      args: [scv.u64(subscriptionId)],
    };
  },

  cancelSubscription(subscriber: string, subscriptionId: bigint | number): ContractCall {
    return {
      contract: "subscriptionManager",
      method: "cancel",
      args: [scv.address(subscriber), scv.u64(subscriptionId)],
    };
  },

  /** MerchantRegistry.approve(operator, id) */
  approveMerchant(operator: string, merchantId: bigint | number): ContractCall {
    return {
      contract: "merchantRegistry",
      method: "approve",
      args: [scv.address(operator), scv.u64(merchantId)],
    };
  },

  suspendMerchant(operator: string, merchantId: bigint | number): ContractCall {
    return {
      contract: "merchantRegistry",
      method: "suspend",
      args: [scv.address(operator), scv.u64(merchantId)],
    };
  },

  /** SettlementManager.open_window(operator, token, period_start, period_end) */
  openSettlementWindow(input: {
    operator: string;
    token: string;
    periodStart: number;
    periodEnd: number;
  }): ContractCall {
    return {
      contract: "settlementManager",
      method: "open_window",
      args: [
        scv.address(input.operator),
        scv.address(input.token),
        scv.u64(input.periodStart),
        scv.u64(input.periodEnd),
      ],
    };
  },

  /** SettlementManager.add_entry(operator, window_id, payee, amount) */
  addSettlementEntry(input: {
    operator: string;
    windowId: bigint | number;
    payee: string;
    amount: bigint;
  }): ContractCall {
    return {
      contract: "settlementManager",
      method: "add_entry",
      args: [
        scv.address(input.operator),
        scv.u64(input.windowId),
        scv.address(input.payee),
        scv.i128(input.amount),
      ],
    };
  },

  /** SettlementManager.close_window(operator, window_id) */
  closeSettlementWindow(operator: string, windowId: bigint | number): ContractCall {
    return {
      contract: "settlementManager",
      method: "close_window",
      args: [scv.address(operator), scv.u64(windowId)],
    };
  },

  /** SettlementManager.execute(operator, window_id) — pays every entry. */
  executeSettlementWindow(operator: string, windowId: bigint | number): ContractCall {
    return {
      contract: "settlementManager",
      method: "execute",
      args: [scv.address(operator), scv.u64(windowId)],
    };
  },

  /** SettlementManager.cancel(admin, window_id) */
  cancelSettlementWindow(admin: string, windowId: bigint | number): ContractCall {
    return {
      contract: "settlementManager",
      method: "cancel",
      args: [scv.address(admin), scv.u64(windowId)],
    };
  },

  /** SettlementManager.fund(from, token, amount) — permissionless pool top-up. */
  fundSettlementPool(input: { from: string; token: string; amount: bigint }): ContractCall {
    return {
      contract: "settlementManager",
      method: "fund",
      args: [scv.address(input.from), scv.address(input.token), scv.i128(input.amount)],
    };
  },

  /** EmergencyPause.pause_all(caller) */
  pauseAll(caller: string): ContractCall {
    return { contract: "emergencyPause", method: "pause_all", args: [scv.address(caller)] };
  },

  unpauseAll(caller: string): ContractCall {
    return { contract: "emergencyPause", method: "unpause_all", args: [scv.address(caller)] };
  },

  /** TreasuryVault.withdraw(admin, token, to, amount) */
  withdrawTreasury(input: {
    admin: string;
    token: string;
    to: string;
    amount: bigint;
  }): ContractCall {
    return {
      contract: "treasuryVault",
      method: "withdraw",
      args: [scv.address(input.admin), scv.address(input.token), scv.address(input.to), scv.i128(input.amount)],
    };
  },
} as const;
