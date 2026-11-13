import { createHash } from "node:crypto";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRedisClient,
  type RateLimitDecision,
  type RateLimitStore,
} from "./rate-limit.store";

export interface LoginThrottleResult {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Per-account failed-login limiter. The per-IP rate limit cannot stop a
 * distributed password spray, so failures are counted per email address in the
 * same Redis store as the request limiter. Counters are keyed by a hash, so no
 * plaintext address is stored, and they clear on a successful sign-in.
 */
export class LoginThrottle {
  readonly maxAttempts: number;
  readonly windowMs: number;
  private readonly store: RateLimitStore;

  constructor(
    env: Pick<{ REDIS_URL?: string }, "REDIS_URL">,
    options: { maxAttempts?: number; windowMs?: number; store?: RateLimitStore } = {},
  ) {
    this.maxAttempts =
      options.maxAttempts ?? (Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5) || 5);
    this.windowMs =
      options.windowMs ??
      (Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15) || 15) * 60_000;
    this.store =
      options.store ??
      (env.REDIS_URL
        ? new RedisRateLimitStore(createRedisClient(env.REDIS_URL))
        : new MemoryRateLimitStore());
  }

  private key(email: string): string {
    return `login:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`;
  }

  /** Counts one attempt and reports whether the account is now locked. */
  async record(email: string): Promise<LoginThrottleResult> {
    const decision: RateLimitDecision = await this.store.hit(this.key(email), this.windowMs);
    return {
      locked: decision.count > this.maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)),
    };
  }

  async reset(email: string): Promise<void> {
    await this.store.reset(this.key(email));
  }
}
