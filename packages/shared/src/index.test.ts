import { describe, expect, it } from "vitest";
import {
  WPayError,
  backoffDelayMs,
  buildWalletAuthMessage,
  decodeCursor,
  encodeCursor,
  isPositiveAmount,
  normalizeAmount,
  shortAddress,
  signWebhook,
  verifyWebhook,
} from "./index";

describe("amounts", () => {
  it("accepts positive integer strings only", () => {
    expect(isPositiveAmount("1")).toBe(true);
    expect(isPositiveAmount("0")).toBe(false);
    expect(isPositiveAmount("-1")).toBe(false);
    expect(isPositiveAmount("1.5")).toBe(false);
  });

  it("normalizes leading zeroes", () => {
    expect(normalizeAmount("000123")).toBe("123");
    expect(() => normalizeAmount("12a")).toThrow(WPayError);
  });
});

describe("cursors", () => {
  it("round-trips an identifier", () => {
    const id = "clx0abc123456789";
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it("rejects malformed input", () => {
    expect(() => decodeCursor("!!!")).toThrow(WPayError);
  });
});

describe("addresses", () => {
  it("shortens long addresses", () => {
    const address = "G".padEnd(56, "A");
    expect(shortAddress(address)).toBe("GAAAA…AAAAA");
    expect(shortAddress("GABC")).toBe("GABC");
  });
});

describe("wallet auth message", () => {
  it("is deterministic and includes the nonce", () => {
    const message = buildWalletAuthMessage({
      domain: "app.wpay.dev",
      address: "GABC",
      nonce: "n-123",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message).toContain("app.wpay.dev");
    expect(message).toContain("Nonce: n-123");
    expect(message.split("\n")).toHaveLength(5);
  });
});

describe("webhooks", () => {
  const secret = "whsec_test_secret_value";

  it("verifies a freshly signed payload", async () => {
    const body = JSON.stringify({ event: "payment.settled", id: "p_1" });
    const now = 1_700_000_000;
    const headers = await signWebhook(body, secret, now);
    await expect(
      verifyWebhook({
        body,
        secret,
        signature: headers["x-wpay-signature"],
        timestamp: headers["x-wpay-timestamp"],
        now,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const now = 1_700_000_000;
    const headers = await signWebhook("{}", secret, now);
    await expect(
      verifyWebhook({
        body: '{"tampered":true}',
        secret,
        signature: headers["x-wpay-signature"],
        timestamp: headers["x-wpay-timestamp"],
        now,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const now = 1_700_000_000;
    const headers = await signWebhook("{}", secret, now - 3_600);
    await expect(
      verifyWebhook({
        body: "{}",
        secret,
        signature: headers["x-wpay-signature"],
        timestamp: headers["x-wpay-timestamp"],
        now,
      }),
    ).resolves.toBe(false);
  });
});

describe("backoff", () => {
  it("grows and is bounded", () => {
    expect(backoffDelayMs(1, 100, 10_000)).toBeGreaterThanOrEqual(100);
    expect(backoffDelayMs(10, 100, 10_000)).toBeLessThanOrEqual(12_000);
  });
});
