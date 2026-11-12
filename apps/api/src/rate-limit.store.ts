import { Logger } from "@nestjs/common";

/**
 * Fixed-window counters for the API rate limiter.
 *
 * The in-process store keeps the single-replica behaviour identical to before.
 * The Redis store makes the limit shared across replicas, which is required
 * once the API runs with more than one pod: without it each replica enforces
 * its own quota and the effective limit multiplies by the replica count.
 *
 * Both stores are fixed-window. Redis increments and sets the expiry in one
 * atomic script so two concurrent requests cannot both observe "count === 1"
 * and leave a key without a TTL.
 */

export interface RateLimitDecision {
  count: number;
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number;
}

export interface RateLimitStore {
  /** Records one request for `key` and returns the running window state. */
  hit(key: string, windowMs: number): Promise<RateLimitDecision>;
  /** Releases resources; safe to call more than once. */
  close?(): Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(maxKeys = 100_000) {
    this.maxKeys = maxKeys;
  }

  async hit(key: string, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      return { ...fresh };
    }
    bucket.count += 1;
    // Return a snapshot: the stored bucket keeps mutating on later requests.
    return { count: bucket.count, resetAt: bucket.resetAt };
  }

  /** Drops expired windows once the map grows large. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

/** Minimal slice of node-redis used here, so tests can inject a fake. */
export interface RedisLike {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  isOpen?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const PREFIX = "wpay:ratelimit:";
/** How long to keep serving from memory after a Redis failure before retrying. */
const RETRY_AFTER_MS = 30_000;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly logger = new Logger("rate-limit");
  private readonly fallback = new MemoryRateLimitStore();
  private ready: Promise<void> | null = null;
  private degradedUntil = 0;

  constructor(
    private readonly client: RedisLike,
    private readonly onDegrade?: (reason: string) => void,
  ) {
    this.client.on?.("error", (error) => {
      this.degrade(error instanceof Error ? error.message : String(error));
    });
  }

  async hit(key: string, windowMs: number): Promise<RateLimitDecision> {
    if (Date.now() < this.degradedUntil) {
      return this.fallback.hit(key, windowMs);
    }
    try {
      await this.ensureConnected();
      const result = await this.client.eval(SCRIPT, {
        keys: [`${PREFIX}${key}`],
        arguments: [String(windowMs)],
      });
      const [count, ttl] = result as [number | string, number | string];
      const usedTtl = Number(ttl);
      return {
        count: Number(count),
        resetAt: Date.now() + (Number.isFinite(usedTtl) && usedTtl > 0 ? usedTtl : windowMs),
      };
    } catch (error) {
      this.degrade(error instanceof Error ? error.message : String(error));
      return this.fallback.hit(key, windowMs);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen === true) return;
    this.ready ??= (async () => {
      await this.client.connect?.();
    })();
    await this.ready;
    // A failed connection attempt must be retried on the next request.
    if (this.client.isOpen === false) this.ready = null;
  }

  private degrade(reason: string): void {
    this.degradedUntil = Date.now() + RETRY_AFTER_MS;
    this.logger.warn(`redis rate-limit store unavailable, using in-process fallback: ${reason}`);
    this.onDegrade?.(reason);
  }

  async close(): Promise<void> {
    await this.client.quit?.().catch?.(() => undefined);
  }
}

/**
 * Creates a lazily-connected node-redis client. `createClient` does not open a
 * socket until `connect()` is called, so constructing the guard costs nothing
 * when Redis is configured but temporarily unreachable.
 */
export function createRedisClient(url: string): RedisLike {
  // Required lazily: the driver is only loaded when REDIS_URL is set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("redis") as {
    createClient: (options: { url: string }) => RedisLike;
  };
  return createClient({ url });
}

/** True when the process is configured to share limits through Redis. */
export function redisUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.REDIS_URL?.trim();
  return url ? url : undefined;
}
