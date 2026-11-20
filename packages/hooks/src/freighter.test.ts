import { describe, expect, it } from "vitest";
import { assertFreighterNetwork, type FreighterLike } from "./index";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

function wallet(network: string | { network?: string }): FreighterLike {
  return {
    signTransaction: async () => ({ signedTxXdr: "xdr" }),
    getNetwork: async () =>
      typeof network === "string" ? network : { network: network.network },
  };
}

describe("assertFreighterNetwork", () => {
  it("accepts a wallet reporting the matching passphrase", async () => {
    await expect(assertFreighterNetwork(TESTNET, wallet(TESTNET))).resolves.toBeUndefined();
  });

  it("accepts a wallet reporting the matching network name", async () => {
    await expect(assertFreighterNetwork(TESTNET, wallet("TESTNET"))).resolves.toBeUndefined();
    await expect(assertFreighterNetwork(MAINNET, wallet("PUBLIC"))).resolves.toBeUndefined();
  });

  it("rejects a wallet on the wrong network before signing", async () => {
    await expect(assertFreighterNetwork(MAINNET, wallet("TESTNET"))).rejects.toThrow(
      /Switch networks/,
    );
  });

  it("does not block wallets that cannot report a network", async () => {
    const legacy: FreighterLike = { signTransaction: async () => ({ signedTxXdr: "xdr" }) };
    await expect(assertFreighterNetwork(TESTNET, legacy)).resolves.toBeUndefined();
  });
});
