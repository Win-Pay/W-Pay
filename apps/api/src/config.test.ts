import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://wpay:secret@db:5432/wpay",
  JWT_SECRET: "test-secret-that-is-long-enough-for-validation",
  REDIS_URL: "rediss://redis.internal:6379",
  API_PUBLIC_URL: "https://api.wpay.test",
  WEB_PUBLIC_URL: "https://wpay.test",
};

describe("production config", () => {
  it("fails closed without Redis", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: undefined })).toThrow(/REDIS_URL is required/);
  });

  it("allows an explicit single-replica override", () => {
    const config = loadConfig({
      ...base,
      REDIS_URL: undefined,
      ALLOW_IN_MEMORY_RATE_LIMIT: "1",
    });
    expect(config.env.ALLOW_IN_MEMORY_RATE_LIMIT).toBe("1");
  });

  it("rejects plaintext public URLs", () => {
    expect(() => loadConfig({ ...base, API_PUBLIC_URL: "http://api.wpay.test" })).toThrow(
      /must use https/,
    );
  });

  it("rejects placeholder hostnames and secrets", () => {
    expect(() => loadConfig({ ...base, API_PUBLIC_URL: "https://api.example.com" })).toThrow(
      /real public hostname/,
    );
    expect(() =>
      loadConfig({ ...base, JWT_SECRET: "replace-with-at-least-32-random-characters" }),
    ).toThrow(/placeholder/);
  });

  it("defaults browser cookies to Secure and SameSite=None in production", () => {
    const config = loadConfig(base);
    expect(config.cookies).toEqual({
      secure: true,
      sameSite: "none",
      domain: undefined,
    });
  });

  it("keeps development cookies usable over http", () => {
    const config = loadConfig({ ...base, NODE_ENV: "development", REDIS_URL: undefined });
    expect(config.cookies).toEqual({
      secure: false,
      sameSite: "lax",
      domain: undefined,
    });
  });
});
