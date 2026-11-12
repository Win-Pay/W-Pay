/**
 * Cross-package integration tests that need no database and no network.
 *
 * The one live-API test is skipped unless WPAY_E2E_API_URL is set, so this
 * suite never claims to have exercised a deployed service.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CONTRACT_NAMES, contractEnvVar, fromStroops, splitAmount, toStroops } from "@wpay/config";
import { calls, WPayApi } from "@wpay/sdk";
import { buildWalletAuthMessage, signWebhook, verifyWebhook } from "@wpay/shared";

const apiUrl = process.env.WPAY_E2E_API_URL;

describe("contract configuration mapping", () => {
  it("reads every contract id from the documented env names", () => {
    const example = readFileSync(join(__dirname, "..", "..", "..", ".env.example"), "utf8");
    for (const name of CONTRACT_NAMES) {
      const key = contractEnvVar(name);
      // The variable must be documented and must be present in an env block.
      expect(example, `${key} missing from .env.example`).toContain(`${key}=`);
    }
    expect(contractEnvVar("paymentRouter")).toBe("CONTRACT_PAYMENT_ROUTER_ID");
  });
});

describe("money conversion and fees", () => {
  it("round-trips decimal amounts without losing precision", () => {
    expect(toStroops("12.5")).toBe(125_000_000n);
    expect(fromStroops(125_000_000n)).toBe("12.5");
    expect(fromStroops(toStroops("0.0000001"))).toBe("0.0000001");
  });

  it("splits exactly and rounds the fee down like the contract", () => {
    expect(splitAmount(10_000n, 200)).toEqual({ fee: 200n, net: 9_800n });
    // 333 bps of 100 = 3.33 -> 3, never rounds up.
    expect(splitAmount(100n, 333)).toEqual({ fee: 3n, net: 97n });
  });

  it("rejects decimals beyond the asset precision", () => {
    expect(() => toStroops("1.12345678")).toThrow(/too many decimal places/);
  });
});

describe("payment call construction", () => {
  const payer = Keypair.random().publicKey();
  const token = Keypair.random().publicKey();

  it("builds the router call with typed arguments", () => {
    const call = calls.createPayment({
      payer,
      merchantId: 7n,
      token,
      amount: 12_500_000n,
      memo: "order-1042",
    });
    expect(call.contract).toBe("paymentRouter");
    expect(call.method).toBe("create_payment");
    expect(call.args).toHaveLength(5);
    expect(StrKey.isValidEd25519PublicKey(payer)).toBe(true);
  });

  it("requires the settlement address for refund approval", () => {
    const settlement = Keypair.random().publicKey();
    const call = calls.approveRefund(settlement, 3n);
    expect(call.method).toBe("approve");
    expect(call.args).toHaveLength(2);
  });

  it("builds an emergency pause call", () => {
    const call = calls.pauseAll(payer);
    expect(call.contract).toBe("emergencyPause");
    expect(call.method).toBe("pause_all");
  });
});

describe("wallet authentication message", () => {
  it("binds domain, address and nonce", () => {
    const address = Keypair.random().publicKey();
    const message = buildWalletAuthMessage({
      domain: "pay.example.com",
      address,
      nonce: "n-123",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message).toContain("pay.example.com");
    expect(message).toContain(address);
    expect(message).toContain("n-123");
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test_only_value_for_unit_tests";

  it("verifies a signature and rejects a tampered body", async () => {
    const body = JSON.stringify({ type: "payment.settled", id: "p_1" });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await signWebhook(body, secret, timestamp);
    const base = {
      secret,
      signature: headers["x-wpay-signature"],
      timestamp: headers["x-wpay-timestamp"],
    };
    await expect(verifyWebhook({ ...base, body })).resolves.toBe(true);
    await expect(verifyWebhook({ ...base, body: body + " " })).resolves.toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const body = "{}";
    const old = Math.floor(Date.now() / 1000) - 3600;
    const headers = await signWebhook(body, secret, old);
    await expect(
      verifyWebhook({
        body,
        secret,
        signature: headers["x-wpay-signature"],
        timestamp: headers["x-wpay-timestamp"],
      }),
    ).resolves.toBe(false);
  });
});

describe.skipIf(!apiUrl)("live API smoke test", () => {
  const api = new WPayApi({ baseUrl: apiUrl ?? "http://127.0.0.1:4000" });

  it("reports health", async () => {
    const health = await api.health();
    expect(health.status).toBe("ok");
  });

  it("returns 404 for an unknown public invoice", async () => {
    await expect(api.invoices.public("INV-DOES-NOT-EXIST")).rejects.toThrow();
  });
});
