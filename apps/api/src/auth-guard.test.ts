import { describe, expect, it } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import type { AppConfig } from "./config";
import { AuthGuard } from "./common";

const secret = "test-secret-that-is-long-enough-for-validation";

function context(authorization?: string): ExecutionContext {
  const request = {
    headers: { authorization },
    header(name: string) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(): AuthGuard {
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const jwt = new JwtService({ secret, signOptions: { algorithm: "HS256" } });
  return new AuthGuard(reflector, jwt, {} as never, {
    adminAddresses: [],
  } as unknown as AppConfig);
}

const payload = { sub: "u_1", email: "a@b.c", role: "ADMIN", address: null };

describe("AuthGuard JWT algorithm pinning", () => {
  it("accepts an HS256 token signed with the configured secret", async () => {
    const token = new JwtService({ secret }).sign(payload, { algorithm: "HS256", expiresIn: 60 });
    await expect(guard().canActivate(context(`Bearer ${token}`))).resolves.toBe(true);
  });

  it("rejects a token signed with a different algorithm even when the secret matches", async () => {
    const token = new JwtService({ secret }).sign(payload, { algorithm: "HS384", expiresIn: 60 });
    await expect(guard().canActivate(context(`Bearer ${token}`))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects an unsigned token", async () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
    await expect(guard().canActivate(context(`Bearer ${token}`))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
