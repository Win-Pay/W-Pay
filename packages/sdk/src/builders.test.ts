import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { calls } from "./builders";
import { scv } from "./soroban";

describe("contract call builders", () => {
  it("encodes a payment call in contract argument order", () => {
    const payer = Keypair.random().publicKey();
    const token = Keypair.random().publicKey();
    const call = calls.createPayment({
      payer,
      merchantId: 7n,
      token,
      amount: 12_345n,
      memo: "order-1",
    });

    expect(call.contract).toBe("paymentRouter");
    expect(call.method).toBe("create_payment");
    expect(call.args).toHaveLength(5);
    // The first argument must be the payer address, not the merchant.
    expect(call.args[0]?.switch().name).toBe("scvAddress");
    expect(call.args[1]?.switch().name).toBe("scvU64");
    expect(call.args[3]?.switch().name).toBe("scvI128");
    expect(call.args[4]?.switch().name).toBe("scvString");
  });

  it("encodes invoice due dates as u64", () => {
    const call = calls.createInvoice({
      owner: Keypair.random().publicKey(),
      merchantId: 1,
      token: Keypair.random().publicKey(),
      amount: 5_000n,
      dueAt: 1_800_000_000,
      memo: "",
    });
    expect(call.args[4]?.switch().name).toBe("scvU64");
  });

  it("encodes escrow release boolean", () => {
    const call = calls.resolveEscrow(Keypair.random().publicKey(), 3n, false);
    expect(call.method).toBe("resolve");
    expect(call.args[2]?.switch().name).toBe("scvBool");
    expect(call.args[2]?.b()).toBe(false);
  });

  it("encodes settlement window and entry calls", () => {
    const operator = Keypair.random().publicKey();
    const token = Keypair.random().publicKey();
    const payee = Keypair.random().publicKey();
    const open = calls.openSettlementWindow({
      operator,
      token,
      periodStart: 1_700_000_000,
      periodEnd: 1_700_086_400,
    });
    expect(open.contract).toBe("settlementManager");
    expect(open.method).toBe("open_window");
    expect(open.args[2]?.switch().name).toBe("scvU64");

    const entry = calls.addSettlementEntry({ operator, windowId: 4n, payee, amount: 1_000n });
    expect(entry.method).toBe("add_entry");
    expect(entry.args[1]?.switch().name).toBe("scvU64");
    expect(entry.args[3]?.switch().name).toBe("scvI128");

    expect(calls.closeSettlementWindow(operator, 4n).method).toBe("close_window");
    expect(calls.executeSettlementWindow(operator, 4n).method).toBe("execute");
    expect(calls.cancelSettlementWindow(operator, 4n).method).toBe("cancel");
  });

  it("rejects a malformed bytes32", () => {
    expect(() => scv.bytes32("not-hex")).toThrow(/bytes32/);
  });
});
