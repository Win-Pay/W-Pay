import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle";
import { MemoryRateLimitStore } from "./rate-limit.store";

function throttle(maxAttempts = 5, windowMs = 60_000): LoginThrottle {
  return new LoginThrottle({}, { maxAttempts, windowMs, store: new MemoryRateLimitStore() });
}

describe("LoginThrottle", () => {
  it("allows the configured number of attempts and locks the next one", async () => {
    const limiter = throttle(5);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(limiter.record("person@example.com")).resolves.toMatchObject({ locked: false });
    }
    const locked = await limiter.record("person@example.com");
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts addresses case-insensitively and independently", async () => {
    const limiter = throttle(2);
    await limiter.record("Person@Example.com");
    await limiter.record("person@example.com");
    await expect(limiter.record("person@example.com")).resolves.toMatchObject({ locked: true });
    await expect(limiter.record("other@example.com")).resolves.toMatchObject({ locked: false });
  });

  it("clears the counter after a successful sign-in", async () => {
    const limiter = throttle(2);
    await limiter.record("person@example.com");
    await limiter.record("person@example.com");
    await limiter.record("person@example.com");
    await limiter.reset("person@example.com");
    await expect(limiter.record("person@example.com")).resolves.toMatchObject({ locked: false });
  });

  it("releases the lock once the window expires", async () => {
    const limiter = throttle(1, 20);
    await limiter.record("person@example.com");
    await expect(limiter.record("person@example.com")).resolves.toMatchObject({ locked: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(limiter.record("person@example.com")).resolves.toMatchObject({ locked: false });
  });
});
