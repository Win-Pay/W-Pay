/**
 * Rate limit store tests.
 *
 * The Redis store is exercised against an in-memory fake that implements the
 * same atomic script semantics, so the guard's behaviour can be verified
 * without a live Redis. The degradation path (Redis down) must keep enforcing
 * a limit instead of silently disabling it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRedisClient,
  redisUrlFromEnv,
  type RedisLike,
} from "./rate-limit.store";

class FakeRedis implements RedisLike {
  readonly counts = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  isOpen = true;
  failNext = false;
  connectCalls = 0;
  quitCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
  }

  on(): void {
    /* no-op */
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("connection reset");
    }
    expect(script).toContain("INCR");
    const key = options.keys[0]!;
    const windowMs = Number(options.arguments[0]);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count === 1 || !this.expiries.has(key)) {
      this.expiries.set(key, Date.now() + windowMs);
    }
    const ttl = this.expiries.get(key)! - Date.now();
    return [count, ttl];
  }
}

describe("MemoryRateLimitStore", () => {
  it("counts requests inside a window", async () => {
    const store = new MemoryRateLimitStore();
    const first = await store.hit("user-a", 60_000);
    const second = await store.hit("user-a", 60_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.resetAt).toBe(first.resetAt);
  });

  it("keeps separate counters per key", async () => {
    const store = new MemoryRateLimitStore();
    await store.hit("a", 60_000);
    const other = await store.hit("b", 60_000);
    expect(other.count).toBe(1);
  });

  it("starts a new window once the previous one expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRateLimitStore();
      await store.hit("k", 1_000);
      vi.advanceTimersByTime(1_001);
      const next = await store.hit("k", 1_000);
      expect(next.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps expired keys instead of growing without bound", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRateLimitStore(2);
      await store.hit("a", 1_000);
      await store.hit("b", 1_000);
      vi.advanceTimersByTime(1_001);
      await store.hit("c", 1_000);
      expect(store.size()).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RedisRateLimitStore", () => {
  it("increments the shared counter", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const first = await store.hit("user-a", 60_000);
    const second = await store.hit("user-a", 60_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(redis.counts.get("wpay:ratelimit:user-a")).toBe(2);
  });

  it("reports a reset time derived from the Redis TTL", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const decision = await store.hit("k", 30_000);
    const remaining = decision.resetAt - Date.now();
    expect(remaining).toBeGreaterThan(25_000);
    expect(remaining).toBeLessThanOrEqual(30_000);
  });

  it("shares one counter across two store instances (two replicas)", async () => {
    const redis = new FakeRedis();
    const replicaA = new RedisRateLimitStore(redis);
    const replicaB = new RedisRateLimitStore(redis);
    expect((await replicaA.hit("shared", 60_000)).count).toBe(1);
    expect((await replicaB.hit("shared", 60_000)).count).toBe(2);
  });

  it("falls back to an in-process limit when Redis errors", async () => {
    const redis = new FakeRedis();
    const onDegrade = vi.fn();
    const store = new RedisRateLimitStore(redis, onDegrade);
    await store.hit("k", 60_000);

    redis.failNext = true;
    const afterFailure = await store.hit("k", 60_000);
    // The fallback store starts its own window at 1, and the limit keeps working.
    expect(afterFailure.count).toBe(1);
    expect(onDegrade).toHaveBeenCalledTimes(1);

    const second = await store.hit("k", 60_000);
    expect(second.count).toBe(2);
  });

  it("connects once even when called concurrently", async () => {
    const redis = new FakeRedis();
    redis.isOpen = false;
    const store = new RedisRateLimitStore(redis);
    await Promise.all([store.hit("a", 60_000), store.hit("b", 60_000)]);
    expect(redis.connectCalls).toBe(1);
  });

  it("closes the underlying client", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    await store.close();
    expect(redis.quitCalls).toBe(1);
  });
});

describe("createRedisClient", () => {
  it("builds a client without opening a connection", () => {
    const client = createRedisClient("redis://127.0.0.1:6379");
    // No socket is opened by construction; quit() would throw on a closed client.
    expect(client.isOpen).toBe(false);
  });
});

describe("redisUrlFromEnv", () => {
  it("ignores unset and blank values", () => {
    expect(redisUrlFromEnv({})).toBeUndefined();
    expect(redisUrlFromEnv({ REDIS_URL: "   " })).toBeUndefined();
  });

  it("returns a configured URL", () => {
    expect(redisUrlFromEnv({ REDIS_URL: "redis://redis:6379" })).toBe("redis://redis:6379");
  });
});
