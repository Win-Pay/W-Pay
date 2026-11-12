import { describe, expect, it } from "vitest";
import { fromDbAmount, pageFrom, serializeBigInts, toDbAmount } from "./index";

describe("amount mapping", () => {
  it("round-trips decimal strings", () => {
    expect(toDbAmount("123456789012345678901")).toBe(123456789012345678901n);
    expect(fromDbAmount(123456789012345678901n)).toBe("123456789012345678901");
  });

  it("rejects malformed amounts", () => {
    expect(() => toDbAmount("-1")).toThrow();
    expect(() => toDbAmount("1.5")).toThrow();
    expect(() => toDbAmount("")).toThrow();
  });
});

describe("serializeBigInts", () => {
  it("converts nested bigints to strings without touching dates", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const value = { amount: 10n, nested: [{ fee: 2n }], date };
    const serialized = serializeBigInts(value);
    expect(serialized.amount).toBe("10");
    expect(serialized.nested[0]?.fee).toBe("2");
    expect(serialized.date).toBe(date);
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});

describe("pageFrom", () => {
  it("returns a cursor only when more rows exist", () => {
    expect(pageFrom([{ id: "a" }, { id: "b" }], 5)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    });
    expect(pageFrom([{ id: "a" }, { id: "b" }, { id: "c" }], 2)).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      nextCursor: "b",
    });
  });
});
