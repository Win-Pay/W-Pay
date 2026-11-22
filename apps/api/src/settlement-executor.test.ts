import { Keypair, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { WalletSigner } from "@wpay/sdk";
import type { SorobanService } from "./soroban.service";
import {
  normalizeSettlementStatus,
  parseOnChainEntries,
  parseWindowId,
  SettlementExecutionError,
  SorobanSettlementExecutor,
  type SettlementExecutionWindow,
} from "./settlement-executor";

const operator = Keypair.random().publicKey();
const token = Keypair.random().publicKey();
const payeeA = Keypair.random().publicKey();
const payeeB = Keypair.random().publicKey();

interface FakeEntry {
  payee: string;
  amount: bigint;
}

class FakeGateway {
  networkPassphrase = "Test SDF Network ; September 2015";
  window: {
    token: string;
    status: string;
    entries: FakeEntry[];
    executed_at?: number | null;
  } = { token, status: "OPEN", entries: [] };
  calls: { method: string; entries: number }[] = [];
  failMethod: string | null = null;
  private nextHash = 1;
  private current: { method: string; args: xdr.ScVal[] } | null = null;
  private pending = new Map<string, { method: string; args: xdr.ScVal[] }>();

  hasContract(): boolean {
    return true;
  }

  async read<T>(): Promise<T> {
    return this.window as T;
  }

  async prepareInvocation(request: { method: string; args: xdr.ScVal[] }) {
    this.current = request;
    return {
      method: request.method,
      args: request.args,
      toXDR: () => `unsigned:${request.method}`,
    };
  }

  async submit(): Promise<{ hash: string }> {
    if (!this.current) throw new Error("submit without prepareInvocation");
    const hash = `tx-${this.nextHash++}`;
    this.pending.set(hash, this.current);
    return { hash };
  }

  async awaitTransaction(hash: string) {
    const pending = this.pending.get(hash);
    if (!pending) throw new Error(`unknown transaction ${hash}`);
    this.calls.push({ method: pending.method, entries: this.window.entries.length });
    if (this.failMethod === pending.method) {
      return { status: "FAILED", hash, returnValue: null };
    }
    if (pending.method === "open_window") {
      this.window = {
        token: String(scValToNative(pending.args[1])),
        status: "OPEN",
        entries: [],
      };
      return { status: "SUCCESS", hash, returnValue: 42n };
    }
    if (pending.method === "add_entry") {
      this.window.entries.push({
        payee: String(scValToNative(pending.args[2])),
        amount: BigInt(scValToNative(pending.args[3]) as bigint),
      });
    }
    if (pending.method === "close_window") this.window.status = "CLOSED";
    if (pending.method === "execute") {
      this.window.status = "EXECUTED";
      this.window.executed_at = 1;
    }
    return { status: "SUCCESS", hash, returnValue: null };
  }
}

function fakeSoroban(gateway: FakeGateway, signer: WalletSigner | null = signerFor()) {
  return {
    operatorSigner: () => signer,
    has: () => true,
    gateway,
  } as unknown as SorobanService;
}

function signerFor(): WalletSigner {
  return {
    publicKey: operator,
    async signTransaction() {
      return { signedTxXdr: "signed" };
    },
  };
}

function makeWindow(
  entries: { payee: string; amount: bigint }[],
  windowIdOnChain: bigint | null = null,
): SettlementExecutionWindow {
  return {
    id: "window-1",
    token,
    periodStart: new Date("2026-11-01T00:00:00Z"),
    periodEnd: new Date("2026-11-08T00:00:00Z"),
    windowIdOnChain,
    entries,
  };
}

describe("settlement executor parsing", () => {
  it("decodes status shapes and rejects unknown values", () => {
    expect(normalizeSettlementStatus("Executed")).toBe("EXECUTED");
    expect(normalizeSettlementStatus(2)).toBe("EXECUTED");
    expect(normalizeSettlementStatus(1n)).toBe("CLOSED");
    expect(normalizeSettlementStatus([{ name: "cancelled" }])).toBe("CANCELLED");
    expect(normalizeSettlementStatus({ tag: "Open" })).toBe("OPEN");
    expect(normalizeSettlementStatus("weird")).toBeNull();
    expect(normalizeSettlementStatus(9)).toBeNull();
  });

  it("parses positive window ids and entry amounts without precision loss", () => {
    expect(parseWindowId("42")).toBe(42n);
    expect(parseWindowId({ id: 7 })).toBe(7n);
    expect(parseWindowId(0)).toBeNull();
    expect(parseWindowId("-1")).toBeNull();
    expect(parseWindowId("abc")).toBeNull();
    expect(parseOnChainEntries([{ payee: payeeA, amount: { amount: "10000000" } }])).toEqual([
      { payee: payeeA, amount: 10_000_000n },
    ]);
  });

  it("refuses malformed on-chain entries", () => {
    expect(parseOnChainEntries(null)).toBeNull();
    expect(parseOnChainEntries([{ payee: payeeA }])).toBeNull();
    expect(parseOnChainEntries([{ amount: 1n }])).toBeNull();
    expect(parseOnChainEntries([null])).toBeNull();
  });
});

describe("SorobanSettlementExecutor", () => {
  it("is unavailable without an operator signer", async () => {
    const gateway = new FakeGateway();
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway, null), 5);
    expect(executor.available).toBe(false);
    await expect(executor.execute(makeWindow([]))).rejects.toMatchObject({ retryable: false });
  });

  it("returns an already executed window without submitting transactions", async () => {
    const gateway = new FakeGateway();
    gateway.window = { token, status: "EXECUTED", entries: [{ payee: payeeA, amount: 1n }] };
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 5);

    const result = await executor.execute(makeWindow([{ payee: payeeA, amount: 1n }], 42n));

    expect(result).toEqual({
      windowIdOnChain: 42n,
      status: "EXECUTED",
      txHashes: [],
      entriesOnChain: 1,
    });
    expect(gateway.calls).toEqual([]);
  });

  it("opens, adds, closes and executes a new window", async () => {
    const gateway = new FakeGateway();
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 10);

    const result = await executor.execute(
      makeWindow([
        { payee: payeeA, amount: 1_000n },
        { payee: payeeB, amount: 2_000n },
      ]),
    );

    expect(result).toMatchObject({ windowIdOnChain: 42n, status: "EXECUTED", entriesOnChain: 2 });
    expect(result.txHashes).toHaveLength(5);
    expect(gateway.calls.map((call) => call.method)).toEqual([
      "open_window",
      "add_entry",
      "add_entry",
      "close_window",
      "execute",
    ]);
    expect(gateway.window.entries).toEqual([
      { payee: payeeA, amount: 1_000n },
      { payee: payeeB, amount: 2_000n },
    ]);
  });

  it("resumes a partially populated window without duplicating entries", async () => {
    const gateway = new FakeGateway();
    gateway.window = { token, status: "OPEN", entries: [{ payee: payeeA, amount: 1_000n }] };
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 5);

    const result = await executor.execute(
      makeWindow(
        [
          { payee: payeeA, amount: 1_000n },
          { payee: payeeB, amount: 2_000n },
        ],
        42n,
      ),
    );

    expect(result).toMatchObject({ windowIdOnChain: 42n, status: "EXECUTED", entriesOnChain: 2 });
    expect(gateway.calls.map((call) => call.method)).toEqual([
      "add_entry",
      "close_window",
      "execute",
    ]);
    expect(gateway.window.entries).toEqual([
      { payee: payeeA, amount: 1_000n },
      { payee: payeeB, amount: 2_000n },
    ]);
  });

  it("stops at the transaction budget without closing a partial window", async () => {
    const gateway = new FakeGateway();
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 1);

    const result = await executor.execute(makeWindow([{ payee: payeeA, amount: 1_000n }]));

    expect(result).toMatchObject({ windowIdOnChain: 42n, status: "OPEN", entriesOnChain: 0 });
    expect(gateway.calls.map((call) => call.method)).toEqual(["open_window"]);
  });

  it("executes a closed window when entries already match", async () => {
    const gateway = new FakeGateway();
    gateway.window = { token, status: "CLOSED", entries: [{ payee: payeeA, amount: 1_000n }] };
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 2);

    const result = await executor.execute(makeWindow([{ payee: payeeA, amount: 1_000n }], 42n));

    expect(result).toMatchObject({ status: "EXECUTED", entriesOnChain: 1 });
    expect(gateway.calls.map((call) => call.method)).toEqual(["execute"]);
  });

  it("rejects token, payee and amount mismatches as non-retryable", async () => {
    const run = (window: FakeGateway["window"]) => {
      const gateway = new FakeGateway();
      gateway.window = window;
      return new SorobanSettlementExecutor(fakeSoroban(gateway), 5).execute(
        makeWindow([{ payee: payeeA, amount: 1_000n }], 42n),
      );
    };

    await expect(
      run({ token: Keypair.random().publicKey(), status: "OPEN", entries: [] }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      run({ token, status: "OPEN", entries: [{ payee: payeeB, amount: 1_000n }] }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      run({ token, status: "OPEN", entries: [{ payee: payeeA, amount: 2_000n }] }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("rejects cancelled, closed-with-wrong-count and undecodable windows", async () => {
    const run = (window: FakeGateway["window"], linked = true) => {
      const gateway = new FakeGateway();
      gateway.window = window;
      return new SorobanSettlementExecutor(fakeSoroban(gateway), 5).execute(
        makeWindow([{ payee: payeeA, amount: 1_000n }], linked ? 42n : null),
      );
    };

    await expect(run({ token, status: "CANCELLED", entries: [] })).rejects.toMatchObject({
      retryable: false,
    });
    await expect(run({ token, status: "CLOSED", entries: [] })).rejects.toMatchObject({
      retryable: false,
    });
    await expect(run({ token, status: "MYSTERY", entries: [] })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("fails a submitted transaction as retryable", async () => {
    const gateway = new FakeGateway();
    gateway.window = { token, status: "CLOSED", entries: [{ payee: payeeA, amount: 1_000n }] };
    gateway.failMethod = "execute";
    const executor = new SorobanSettlementExecutor(fakeSoroban(gateway), 2);

    const error = await executor
      .execute(makeWindow([{ payee: payeeA, amount: 1_000n }], 42n))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SettlementExecutionError);
    expect((error as SettlementExecutionError).retryable).toBe(true);
  });
});
