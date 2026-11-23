import { describe, expect, it, vi } from "vitest";
import {
  assertFreighterNetwork,
  connectFreighter,
  freighterSdkAdapter,
  type FreighterLike,
  type FreighterSdk,
} from "./index";

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

describe("official Freighter SDK adapter", () => {
  function sdk(overrides: Partial<FreighterSdk> = {}): FreighterSdk {
    return {
      isConnected: async () => ({ isConnected: true }),
      requestAccess: async () => ({ address: "GCC..." }),
      getAddress: async () => ({ address: "GCC..." }),
      getNetwork: async () => ({
        network: "TESTNET",
        networkPassphrase: TESTNET,
      }),
      signTransaction: async () => ({ signedTxXdr: "signed-xdr" }),
      signMessage: async () => ({ signedMessage: "c2ln", signerAddress: "GCC..." }),
      ...overrides,
    };
  }

  it("maps the SDK responses onto the structural wallet interface", async () => {
    const wallet = freighterSdkAdapter(sdk());
    await expect(wallet.getAddress?.()).resolves.toEqual({ address: "GCC..." });
    await expect(wallet.getNetwork?.()).resolves.toEqual({
      network: "TESTNET",
      networkPassphrase: TESTNET,
    });
    await expect(
      wallet.signTransaction("xdr", { networkPassphrase: TESTNET }),
    ).resolves.toEqual({ signedTxXdr: "signed-xdr" });
  });

  it("turns SDK errors into rejected promises instead of returning empty values", async () => {
    const wallet = freighterSdkAdapter(
      sdk({
        signTransaction: async () => ({
          signedTxXdr: "",
          error: { message: "User declined access" },
        }),
      }),
    );
    await expect(wallet.signTransaction("xdr", { networkPassphrase: TESTNET })).rejects.toThrow(
      /User declined access/,
    );
  });

  it("encodes buffer message signatures as base64", async () => {
    const wallet = freighterSdkAdapter(
      sdk({
        signMessage: async () => ({
          signedMessage: {
            toString: (encoding?: string) =>
              encoding === "base64" ? "c2lnbmVk" : "[object Object]",
          },
          signerAddress: "GCC...",
        }),
      }),
    );
    await expect(wallet.signMessage?.("message")).resolves.toEqual({
      signedMessage: "c2lnbmVk",
      signerAddress: "GCC...",
    });
  });

  it("prefers a legacy injected provider for existing integrations and tests", async () => {
    const legacy = {
      getAddress: async () => ({ address: "GLEGACY" }),
      signTransaction: async () => ({ signedTxXdr: "legacy" }),
    };
    vi.stubGlobal("window", { freighter: legacy });
    try {
      const connected = await connectFreighter();
      expect(connected.address).toBe("GLEGACY");
      expect(connected.wallet).toBe(legacy);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
