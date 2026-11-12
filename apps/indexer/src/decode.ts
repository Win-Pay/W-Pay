import { scValToNative, xdr } from "@stellar/stellar-sdk";

export interface RawEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
  pagingToken?: string;
}

export interface DecodedEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  /** First topic, e.g. "payment", "refund", "plan". */
  kind: string;
  /** Remaining topics (often the entity id). */
  topics: unknown[];
  data: unknown;
}

/**
 * Decodes a Soroban event into `{ kind, topics, data }`.
 *
 * Contracts publish `(symbol_short!("payment"), id)` with the payload as data.
 * Values that cannot be decoded are kept as their paging token so the event is
 * still recorded and can be investigated rather than dropped.
 */
export function decodeEvent(raw: RawEvent): DecodedEvent {
  let topics: unknown[] = [];
  let data: unknown = null;
  try {
    topics = raw.topics.map((topic) => scValToNative(topic));
  } catch {
    topics = [];
  }
  try {
    data = scValToNative(raw.value);
  } catch {
    data = null;
  }
  const [kind, ...rest] = topics;
  return {
    contractId: raw.contractId,
    ledger: raw.ledger,
    txHash: raw.txHash,
    kind: typeof kind === "string" ? kind : "unknown",
    topics: rest,
    data,
  };
}

/** JSON-safe representation for the IndexedEvent.payload column. */
export function eventPayload(event: DecodedEvent): Record<string, unknown> {
  return {
    kind: event.kind,
    topics: jsonSafe(event.topics),
    data: jsonSafe(event.data),
  };
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, entry]) => [String(key), jsonSafe(entry)]));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonSafe(entry);
    }
    return result;
  }
  return value;
}

export interface PaymentUpdate {
  contractPaymentId: string;
  txHash: string;
  ledger: number;
  payer?: string;
  amount?: string;
  fee?: string;
}

/**
 * Plans the database effect of an event without touching the database, so the
 * mapping is unit-testable.
 */
export function planPaymentUpdate(event: DecodedEvent): PaymentUpdate | null {
  if (event.kind !== "payment") return null;
  const id = event.topics[0];
  if (id === undefined || id === null) return null;
  const data = event.data;
  const tuple = Array.isArray(data) ? data : [];
  return {
    contractPaymentId: String(id),
    txHash: event.txHash,
    ledger: event.ledger,
    payer: typeof tuple[0] === "string" ? tuple[0] : undefined,
    amount: tuple[2] !== undefined ? String(tuple[2]) : undefined,
    fee: tuple[3] !== undefined ? String(tuple[3]) : undefined,
  };
}
