import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BadRequestException } from "@nestjs/common";
import {
  apiKeyPrefix,
  canAccessMerchant,
  generateApiKey,
  hashApiKey,
  serializeBigInts,
  ZodPipe,
  type AuthUser,
} from "./common";

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u_1",
    email: "owner@example.com",
    role: "MERCHANT",
    stellarAddress: null,
    scopedMerchantId: null,
    viaApiKey: false,
    ...overrides,
  };
}

describe("merchant access rule", () => {
  const merchant = { id: "m_1", ownerUserId: "u_1" };

  it("lets an owner in", () => {
    expect(canAccessMerchant(user(), merchant)).toBe(true);
  });

  it("blocks a different user", () => {
    expect(canAccessMerchant(user({ id: "u_2" }), merchant)).toBe(false);
  });

  it("lets admins and operators in", () => {
    expect(canAccessMerchant(user({ id: "a", role: "ADMIN" }), merchant)).toBe(true);
    expect(canAccessMerchant(user({ id: "o", role: "OPERATOR" }), merchant)).toBe(true);
  });

  it("scopes API keys to their merchant", () => {
    const scoped = user({ id: "k", role: "USER", viaApiKey: true, scopedMerchantId: "m_1" });
    expect(canAccessMerchant(scoped, merchant)).toBe(true);
    expect(canAccessMerchant({ ...scoped, scopedMerchantId: "m_2" }, merchant)).toBe(false);
  });

  it("treats an unscoped API key as read-all", () => {
    const unscoped = user({ id: "k", role: "USER", viaApiKey: true, scopedMerchantId: null });
    expect(canAccessMerchant(unscoped, merchant)).toBe(true);
  });
});

describe("api keys", () => {
  it("generates a prefixed key whose hash verifies", () => {
    const generated = generateApiKey();
    expect(generated.key.startsWith("wpay_")).toBe(true);
    expect(generated.prefix).toHaveLength(12);
    expect(generated.prefix).toBe(apiKeyPrefix(generated.key));
    expect(generated.hash).toBe(hashApiKey(generated.key));
    expect(generated.hash).toHaveLength(64);
  });

  it("does not leak the key in the prefix", () => {
    const generated = generateApiKey();
    expect(generated.key.startsWith(generated.prefix)).toBe(true);
    expect(generated.prefix.length).toBeLessThan(generated.key.length / 2);
  });
});

describe("ZodPipe", () => {
  const pipe = new ZodPipe(z.object({ amount: z.string().regex(/^\d+$/) }));

  it("passes valid input through", () => {
    expect(pipe.transform({ amount: "100" }, { type: "body" })).toEqual({ amount: "100" });
  });

  it("rejects invalid input with a validation code", () => {
    try {
      pipe.transform({ amount: "-5" }, { type: "body" });
      throw new Error("expected the pipe to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as { code: string };
      expect(response.code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("serializeBigInts", () => {
  it("converts nested bigints so responses serialize", () => {
    const value = { amount: 42n, nested: { fee: 1n }, list: [3n] };
    const serialized = serializeBigInts(value);
    expect(serialized).toEqual({ amount: "42", nested: { fee: "1" }, list: ["3"] });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
