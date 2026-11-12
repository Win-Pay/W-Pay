import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractName } from "@wpay/config";

export interface DecodedEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  kind: string;
  topics: unknown[];
  data: unknown;
}

export interface RawEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
  pagingToken?: string;
}

export function decodeEvent(raw: {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
}): DecodedEvent {
  const decodedTopics = raw.topics.map((topic) => {
    try {
      return scValToNative(topic);
    } catch {
      return undefined;
    }
  });
  let data: unknown = null;
  try {
    data = scValToNative(raw.value);
  } catch {
    data = null;
  }
  return {
    contractId: raw.contractId,
    ledger: raw.ledger,
    txHash: raw.txHash,
    kind: typeof decodedTopics[0] === "string" ? decodedTopics[0] : "unknown",
    topics: decodedTopics.slice(1),
    data,
  };
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries(), ([k, v]) => [String(k), jsonSafe(v)]));
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

export function eventPayload(event: DecodedEvent): Record<string, unknown> {
  return {
    contractId: event.contractId,
    kind: event.kind,
    topics: jsonSafe(event.topics),
    data: jsonSafe(event.data),
    txHash: event.txHash,
    ledger: event.ledger,
  };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBigIntString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function tuple(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [];
}

export type Projection =
  | {
      type: "payment.settled";
      contractPaymentId: string;
      contractMerchantId?: string;
      payer?: string;
      amount?: string;
      fee?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "payment.refunded";
      contractPaymentId: string;
      refunded: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "refund.requested";
      contractRefundId: string;
      contractPaymentId: string;
      amount?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "refund.approved";
      contractRefundId: string;
      settlement?: string;
      amount?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "refund.rejected";
      contractRefundId: string;
      settlement?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "escrow.created";
      contractEscrowId: string;
      payer?: string;
      payee?: string;
      amount?: string;
      releaseAt?: number;
      txHash: string;
      ledger: number;
    }
  | {
      type: "escrow.status";
      contractEscrowId: string;
      status: "RELEASED" | "REFUNDED" | "DISPUTED";
      txHash: string;
      ledger: number;
    }
  | {
      type: "invoice.created";
      contractInvoiceId: string;
      owner?: string;
      contractMerchantId?: string;
      amount?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "invoice.paid";
      contractInvoiceId: string;
      payer?: string;
      contractPaymentId?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "invoice.status";
      contractInvoiceId: string;
      status: "CANCELLED" | "EXPIRED";
      txHash: string;
      ledger: number;
    }
  | {
      type: "plan.created";
      planIdOnChain: string;
      contractMerchantId?: string;
      amount?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "plan.active";
      planIdOnChain: string;
      active: boolean;
      txHash: string;
      ledger: number;
    }
  | {
      type: "subscription.created";
      contractSubId: string;
      planIdOnChain: string;
      subscriber?: string;
      cycles?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "subscription.charged";
      contractSubId: string;
      cyclesCharged: string;
      amount: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "subscription.cancelled";
      contractSubId: string;
      subscriber?: string;
      refund?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "settlement.opened";
      windowIdOnChain: string;
      token?: string;
      periodStart?: number;
      periodEnd?: number;
      txHash: string;
      ledger: number;
    }
  | {
      type: "settlement.closed";
      windowIdOnChain: string;
      total: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "settlement.executed";
      windowIdOnChain: string;
      total: string;
      operator?: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "settlement.cancelled";
      windowIdOnChain: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "merchant.registered";
      registryId: string;
      owner: string;
      txHash: string;
      ledger: number;
    }
  | {
      type: "merchant.status";
      registryId: string;
      status: "ACTIVE" | "SUSPENDED" | "CLOSED";
      txHash: string;
      ledger: number;
    }
  | {
      type: "merchant.settlement";
      registryId: string;
      settlement: string;
      txHash: string;
      ledger: number;
    };

/**
 * Maps a decoded contract event onto a domain projection. Dispatching by contract
 * name is required because several contracts reuse event names (`cancel`,
 * `refund`, `close`).
 */
export function planEvent(contractName: ContractName, event: DecodedEvent): Projection | null {
  const txHash = event.txHash;
  const ledger = event.ledger;
  const topic = event.topics[0];
  const args = tuple(event.data);

  switch (contractName) {
    case "paymentRouter":
      if (event.kind === "payment") {
        const contractPaymentId = asBigIntString(topic);
        if (!contractPaymentId) return null;
        return {
          type: "payment.settled",
          contractPaymentId,
          contractMerchantId: asBigIntString(args[1]),
          payer: asString(args[0]),
          amount: asBigIntString(args[2]),
          fee: asBigIntString(args[3]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "refund") {
        const contractPaymentId = asBigIntString(topic);
        const refunded = asBigIntString(args[2]);
        if (!contractPaymentId || !refunded) return null;
        return { type: "payment.refunded", contractPaymentId, refunded, txHash, ledger };
      }
      return null;

    case "refundManager":
      if (event.kind === "request") {
        const contractRefundId = asBigIntString(topic);
        const contractPaymentId = asBigIntString(args[0]);
        if (!contractRefundId || !contractPaymentId) return null;
        return {
          type: "refund.requested",
          contractRefundId,
          contractPaymentId,
          amount: asBigIntString(args[1]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "approve") {
        const contractRefundId = asBigIntString(topic);
        if (!contractRefundId) return null;
        return {
          type: "refund.approved",
          contractRefundId,
          settlement: asString(args[0]),
          amount: asBigIntString(args[1]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "reject") {
        const contractRefundId = asBigIntString(topic);
        if (!contractRefundId) return null;
        return {
          type: "refund.rejected",
          contractRefundId,
          settlement: asString(args[0]),
          txHash,
          ledger,
        };
      }
      return null;

    case "escrowManager":
      if (event.kind === "escrow") {
        const contractEscrowId = asBigIntString(topic);
        if (!contractEscrowId) return null;
        const releaseAt = args[3];
        return {
          type: "escrow.created",
          contractEscrowId,
          payer: asString(args[0]),
          payee: asString(args[1]),
          amount: asBigIntString(args[2]),
          releaseAt:
            typeof releaseAt === "bigint"
              ? Number(releaseAt)
              : typeof releaseAt === "number"
                ? releaseAt
                : undefined,
          txHash,
          ledger,
        };
      }
      if (event.kind === "release" || event.kind === "refund" || event.kind === "dispute") {
        const contractEscrowId = asBigIntString(topic);
        if (!contractEscrowId) return null;
        return {
          type: "escrow.status",
          contractEscrowId,
          status:
            event.kind === "release" ? "RELEASED" : event.kind === "refund" ? "REFUNDED" : "DISPUTED",
          txHash,
          ledger,
        };
      }
      if (event.kind === "resolve") {
        const contractEscrowId = asBigIntString(topic);
        const releaseToPayee = asBoolean(args[1]);
        if (!contractEscrowId || releaseToPayee === undefined) return null;
        return {
          type: "escrow.status",
          contractEscrowId,
          status: releaseToPayee ? "RELEASED" : "REFUNDED",
          txHash,
          ledger,
        };
      }
      return null;

    case "invoiceManager":
      if (event.kind === "invoice") {
        const contractInvoiceId = asBigIntString(topic);
        if (!contractInvoiceId) return null;
        return {
          type: "invoice.created",
          contractInvoiceId,
          owner: asString(args[0]),
          contractMerchantId: asBigIntString(args[1]),
          amount: asBigIntString(args[2]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "paid") {
        const contractInvoiceId = asBigIntString(topic);
        if (!contractInvoiceId) return null;
        return {
          type: "invoice.paid",
          contractInvoiceId,
          payer: asString(args[0]),
          contractPaymentId: asBigIntString(args[1]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "cancel" || event.kind === "expire") {
        const contractInvoiceId = asBigIntString(topic);
        if (!contractInvoiceId) return null;
        return {
          type: "invoice.status",
          contractInvoiceId,
          status: event.kind === "cancel" ? "CANCELLED" : "EXPIRED",
          txHash,
          ledger,
        };
      }
      return null;

    case "subscriptionManager":
      if (event.kind === "plan") {
        const planIdOnChain = asBigIntString(topic);
        if (!planIdOnChain) return null;
        return {
          type: "plan.created",
          planIdOnChain,
          contractMerchantId: asBigIntString(args[0]),
          amount: asBigIntString(args[1]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "planact") {
        const planIdOnChain = asBigIntString(topic);
        const active = asBoolean(args[1]);
        if (!planIdOnChain || active === undefined) return null;
        return { type: "plan.active", planIdOnChain, active, txHash, ledger };
      }
      if (event.kind === "subscribe") {
        const contractSubId = asBigIntString(topic);
        const planIdOnChain = asBigIntString(args[0]);
        if (!contractSubId || !planIdOnChain) return null;
        return {
          type: "subscription.created",
          contractSubId,
          planIdOnChain,
          subscriber: asString(args[1]),
          cycles: asBigIntString(args[2]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "charge") {
        const contractSubId = asBigIntString(topic);
        const cyclesCharged = asBigIntString(args[0]);
        const amount = asBigIntString(args[1]);
        if (!contractSubId || !cyclesCharged || !amount) return null;
        return {
          type: "subscription.charged",
          contractSubId,
          cyclesCharged,
          amount,
          txHash,
          ledger,
        };
      }
      if (event.kind === "cancel") {
        const contractSubId = asBigIntString(topic);
        if (!contractSubId) return null;
        return {
          type: "subscription.cancelled",
          contractSubId,
          subscriber: asString(args[0]),
          refund: asBigIntString(args[1]),
          txHash,
          ledger,
        };
      }
      return null;

    case "settlementManager":
      if (event.kind === "open") {
        const windowIdOnChain = asBigIntString(topic);
        if (!windowIdOnChain) return null;
        return {
          type: "settlement.opened",
          windowIdOnChain,
          token: asString(args[0]),
          periodStart: typeof args[1] === "bigint" ? Number(args[1]) : undefined,
          periodEnd: typeof args[2] === "bigint" ? Number(args[2]) : undefined,
          txHash,
          ledger,
        };
      }
      if (event.kind === "close") {
        const windowIdOnChain = asBigIntString(topic);
        const total = asBigIntString(args[1]);
        if (!windowIdOnChain || !total) return null;
        return { type: "settlement.closed", windowIdOnChain, total, txHash, ledger };
      }
      if (event.kind === "execute") {
        const windowIdOnChain = asBigIntString(topic);
        const total = asBigIntString(args[1]);
        if (!windowIdOnChain || !total) return null;
        return {
          type: "settlement.executed",
          windowIdOnChain,
          total,
          operator: asString(args[0]),
          txHash,
          ledger,
        };
      }
      if (event.kind === "cancel") {
        const windowIdOnChain = asBigIntString(topic);
        if (!windowIdOnChain) return null;
        return { type: "settlement.cancelled", windowIdOnChain, txHash, ledger };
      }
      return null;

    case "merchantRegistry":
      if (event.kind === "register") {
        const registryId = asBigIntString(args[0]);
        const owner = asString(args[1]);
        if (!registryId || !owner) return null;
        return { type: "merchant.registered", registryId, owner, txHash, ledger };
      }
      if (event.kind === "approve" || event.kind === "suspend") {
        const registryId = asBigIntString(topic);
        if (!registryId) return null;
        return {
          type: "merchant.status",
          registryId,
          status: event.kind === "approve" ? "ACTIVE" : "SUSPENDED",
          txHash,
          ledger,
        };
      }
      if (event.kind === "settle") {
        const registryId = asBigIntString(topic);
        const settlement = asString(args[0]);
        if (!registryId || !settlement) return null;
        return { type: "merchant.settlement", registryId, settlement, txHash, ledger };
      }
      if (event.kind === "close") {
        const registryId = asBigIntString(topic);
        if (!registryId) return null;
        return { type: "merchant.status", registryId, status: "CLOSED", txHash, ledger };
      }
      return null;

    default:
      return null;
  }
}

// Retained for existing consumers/tests; prefer planEvent for new code.
export function planPaymentUpdate(event: DecodedEvent) {
  const projection = planEvent("paymentRouter", event);
  if (!projection || projection.type !== "payment.settled") return null;
  return {
    contractPaymentId: projection.contractPaymentId,
    contractMerchantId: projection.contractMerchantId,
    txHash: projection.txHash,
    ledger: projection.ledger,
    payer: projection.payer,
    amount: projection.amount,
    fee: projection.fee,
  };
}
