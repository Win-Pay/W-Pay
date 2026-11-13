import { describe, expect, it } from "vitest";
import { retainedLedgerRange } from "./indexer";

describe("retainedLedgerRange", () => {
  it("parses the Soroban RPC retention error", () => {
    expect(
      retainedLedgerRange("startLedger must be within the ledger range: 5590029 - 5710988"),
    ).toEqual({ oldest: 5590029, latest: 5710988 });
  });

  it("ignores unrelated errors", () => {
    expect(retainedLedgerRange("contract ID 1 invalid")).toBeNull();
    expect(retainedLedgerRange("connection refused")).toBeNull();
  });
});
