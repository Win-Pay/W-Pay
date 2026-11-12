import { describe, expect, it } from "vitest";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeEvent, eventPayload, jsonSafe, planPaymentUpdate } from "./decode";
import { hashToken } from "./indexer";

function rawEvent(options: {
  topics: xdr.ScVal[];
  value: xdr.ScVal;
  txHash?: string;
  ledger?: number;
}): Parameters<typeof decodeEvent>[0] {
  return {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    ledger: options.ledger ?? 100,
    txHash: options.txHash ?? "a".repeat(64),
    topics: options.topics,
    value: options.value,
  };
}

describe("decodeEvent", () => {
  it("extracts the kind from the first topic", () => {
    const payer = Keypair.random().publicKey();
    const event = decodeEvent(
      rawEvent({
        topics: [nativeToScVal("payment", { type: "symbol" }), nativeToScVal(7n, { type: "u64" })],
        value: nativeToScVal([payer, 3n, 1000n, 25n]),
      }),
    );
    expect(event.kind).toBe("payment");
    expect(event.topics).toEqual([7n]);
    expect(event.data).toEqual([payer, 3n, 1000n, 25n]);
  });

  it("never throws on undecodable values", () => {
    const event = decodeEvent(
      rawEvent({
        topics: [xdr.ScVal.scvVoid()],
        value: xdr.ScVal.scvVoid(),
      }),
    );
    expect(event.kind).toBe("unknown");
    expect(event.data).toBeNull();
  });
});

describe("planPaymentUpdate", () => {
  it("maps a payment event to a database update", () => {
    const payer = Keypair.random().publicKey();
    const event = decodeEvent(
      rawEvent({
        topics: [nativeToScVal("payment", { type: "symbol" }), nativeToScVal(42n, { type: "u64" })],
        value: nativeToScVal([payer, 1n, 5000n, 125n]),
        txHash: "b".repeat(64),
        ledger: 500,
      }),
    );
    const update = planPaymentUpdate(event);
    expect(update).toMatchObject({
      contractPaymentId: "42",
      txHash: "b".repeat(64),
      ledger: 500,
      payer,
      amount: "5000",
      fee: "125",
    });
  });

  it("ignores unrelated events", () => {
    const event = decodeEvent(
      rawEvent({
        topics: [nativeToScVal("refund", { type: "symbol" })],
        value: nativeToScVal(1n),
      }),
    );
    expect(planPaymentUpdate(event)).toBeNull();
  });
});

describe("jsonSafe", () => {
  it("converts bigints, byte arrays and maps", () => {
    const value = {
      amount: 10n,
      bytes: new Uint8Array([1, 2, 3]),
      nested: [1n, { x: 2n }],
      map: new Map([["a", 1n]]),
    };
    expect(jsonSafe(value)).toEqual({
      amount: "10",
      bytes: "010203",
      nested: ["1", { x: "2" }],
      map: { a: "1" },
    });
  });
});

describe("event payload", () => {
  it("is JSON serializable", () => {
    const event = decodeEvent(
      rawEvent({
        topics: [nativeToScVal("payment", { type: "symbol" }), nativeToScVal(1n)],
        value: nativeToScVal(9n),
      }),
    );
    const payload = eventPayload(event);
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(payload.kind).toBe("payment");
  });
});

describe("hashToken", () => {
  it("is deterministic and non-negative", () => {
    expect(hashToken("12345")).toBe(hashToken("12345"));
    expect(hashToken("12345")).toBeGreaterThanOrEqual(0);
    expect(hashToken("12345")).not.toBe(hashToken("12346"));
  });
});
