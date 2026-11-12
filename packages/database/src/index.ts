/**
 * Prisma client singleton plus the serialization helpers the API uses to turn
 * database rows into JSON (BigInt is not JSON-serializable by default).
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { Prisma, PrismaClient } from "@prisma/client";
export type * from "@prisma/client";

/** dto -> database: decimal string to BigInt, rejecting nonsense. */
export function toDbAmount(value: string): bigint {
  if (!/^\d{1,39}$/.test(value)) throw new Error(`invalid amount: ${value}`);
  return BigInt(value);
}

/** database -> dto: BigInt to decimal string. */
export function fromDbAmount(value: bigint): string {
  return value.toString();
}

/** Recursively converts BigInt values to strings so a JSON response is valid. */
export function serializeBigInts<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => serializeBigInts(entry)) as unknown as T;
  if (value instanceof Date) return value as unknown as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serializeBigInts(entry);
    }
    return result as T;
  }
  return value;
}

/** Keyset pagination helper: fetches limit + 1 rows and derives the cursor. */
export function pageFrom<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: last ? last.id : null };
}
