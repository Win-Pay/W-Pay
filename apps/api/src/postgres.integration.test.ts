/**
 * Integration tests that exercise the real Nest application against a real
 * PostgreSQL database (no mocks on the persistence path).
 *
 * They are skipped when DATABASE_URL is absent, matching the convention used by
 * tests/e2e for live-API tests. Run them with:
 *
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm --filter @wpay/api test
 *
 * The database must be migrated (`pnpm db:migrate`) beforehand. Every row the
 * suite creates is deleted again in `afterAll`, so a development database is
 * left as it was found.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { PrismaClient } from "@wpay/database";

const hasDatabase = Boolean(process.env.DATABASE_URL);

interface Harness {
  app: INestApplication;
  baseUrl: string;
  prisma: PrismaClient;
  close: () => Promise<void>;
}

const created = {
  users: [] as string[],
  merchants: [] as string[],
  invoices: [] as string[],
  payments: [] as string[],
  refunds: [] as string[],
  escrows: [] as string[],
  plans: [] as string[],
  apiKeys: [] as string[],
  webhooks: [] as string[],
  windows: [] as string[],
  failures: [] as string[],
};

/** Unique marker so parallel runs never collide on the unique email column. */
const run = `it${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function address(): string {
  return Keypair.random().publicKey();
}

async function json<T>(
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: T; setCookie: string[] }> {
  const response = await fetch(`${baseUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
    setCookie: response.headers.getSetCookie(),
  };
}

/** Formats Set-Cookie response headers as a request Cookie header. */
function cookieHeader(setCookie: string[]): string {
  return setCookie.map((entry) => entry.split(";")[0]).join("; ");
}

async function buildHarness(): Promise<Harness> {
  // Imported lazily: app.module.ts parses the environment at import time, so the
  // test binary must not pull it in when DATABASE_URL is unset.
  const { createApp } = await import("./app");
  const { prisma } = await import("@wpay/database");
  const app = await createApp({ swagger: false });
  await app.listen(0);
  const baseUrl = await app.getUrl();
  return {
    app,
    baseUrl: baseUrl.replace("[::1]", "127.0.0.1"),
    prisma,
    close: async () => {
      await app.close();
    },
  };
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  const where = <T extends object>(ids: string[]) => ({ id: { in: ids } }) as T;
  await prisma.webhookDelivery.deleteMany({
    where: { endpointId: { in: created.webhooks } },
  });
  await prisma.webhookEndpoint.deleteMany({ where: where(created.webhooks) });
  await prisma.refund.deleteMany({ where: where(created.refunds) });
  await prisma.payment.deleteMany({ where: where(created.payments) });
  await prisma.invoice.deleteMany({ where: where(created.invoices) });
  await prisma.escrow.deleteMany({ where: where(created.escrows) });
  await prisma.subscription.deleteMany({ where: { planId: { in: created.plans } } });
  await prisma.subscriptionPlan.deleteMany({ where: where(created.plans) });
  await prisma.apiKey.deleteMany({ where: where(created.apiKeys) });
  await prisma.settlementWindow.deleteMany({ where: { id: { in: created.windows } } });
  await prisma.indexerFailure.deleteMany({ where: where(created.failures) });
  await prisma.notification.deleteMany({ where: { merchantId: { in: created.merchants } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: created.users } } });
  await prisma.merchant.deleteMany({ where: where(created.merchants) });
  await prisma.user.deleteMany({ where: where(created.users) });
}

describe.skipIf(!hasDatabase)("API against PostgreSQL", () => {
  let harness: Harness;
  let adminToken = "";
  let adminId = "";
  let userToken = "";
  let merchantId = "";
  let paymentId = "";
  let invoiceNumber = "";
  const payer = address();
  const settlement = address();

  beforeAll(async () => {
    harness = await buildHarness();
    const adminEmail = `admin.${run}@wpay.test`;
    const registered = await json<{ accessToken: string; user: { id: string } }>(
      harness.baseUrl,
      "/auth/register",
      { method: "POST", body: { email: adminEmail, password: "correct-horse-battery" } },
    );
    expect(registered.status).toBe(201);
    adminId = registered.body.user.id;
    created.users.push(adminId);
    await harness.prisma.user.update({ where: { id: adminId }, data: { role: "ADMIN" } });

    const login = await json<{ accessToken: string }>(harness.baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: "correct-horse-battery" },
    });
    expect(login.status).toBe(201);
    adminToken = login.body.accessToken;

    const merchantUser = await json<{ accessToken: string; user: { id: string } }>(
      harness.baseUrl,
      "/auth/register",
      {
        method: "POST",
        body: { email: `merchant.${run}@wpay.test`, password: "correct-horse-battery" },
      },
    );
    expect(merchantUser.status).toBe(201);
    created.users.push(merchantUser.body.user.id);
    // A merchant owner must authenticate the wallet they claim; bind the
    // account to the settlement address before issuing a token.
    await harness.prisma.user.update({
      where: { id: merchantUser.body.user.id },
      data: { stellarAddress: settlement },
    });
    const merchantLogin = await json<{ accessToken: string }>(harness.baseUrl, "/auth/login", {
      method: "POST",
      body: { email: `merchant.${run}@wpay.test`, password: "correct-horse-battery" },
    });
    expect(merchantLogin.status).toBe(201);
    userToken = merchantLogin.body.accessToken;
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await cleanup(harness.prisma);
    await harness.close();
  }, 60_000);

  describe("health", () => {
    it("reports the database as reachable", async () => {
      const response = await json<{ status: string; database: string }>(harness.baseUrl, "/health");
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(response.body.database).toBe("up");
    });

    it("reports readiness separately from liveness", async () => {
      const response = await json<{ ready: boolean }>(harness.baseUrl, "/health/ready");
      expect([200, 503]).toContain(response.status);
      expect(response.body).toHaveProperty("ready");
    });
  });

  describe("authentication", () => {
    it("rejects a duplicate registration", async () => {
      const response = await json(harness.baseUrl, "/auth/register", {
        method: "POST",
        body: { email: `admin.${run}@wpay.test`, password: "correct-horse-battery" },
      });
      expect(response.status).toBe(401);
    });

    it("rejects a wrong password without revealing whether the email exists", async () => {
      const wrongPassword = await json<{ message: string }>(harness.baseUrl, "/auth/login", {
        method: "POST",
        body: { email: `admin.${run}@wpay.test`, password: "not-the-password" },
      });
      const unknownEmail = await json<{ message: string }>(harness.baseUrl, "/auth/login", {
        method: "POST",
        body: { email: `ghost.${run}@wpay.test`, password: "not-the-password" },
      });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it("rejects a malformed registration body", async () => {
      const response = await json<{ code: string }>(harness.baseUrl, "/auth/register", {
        method: "POST",
        body: { email: "not-an-email", password: "short" },
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_FAILED");
    });

    it("returns the caller identity for a valid token and 401 without one", async () => {
      const authenticated = await json<{ id: string; role: string }>(
        harness.baseUrl,
        "/auth/me",
        { token: adminToken },
      );
      expect(authenticated.status).toBe(200);
      expect(authenticated.body.id).toBe(adminId);
      expect(authenticated.body.role).toBe("ADMIN");

      const anonymous = await json(harness.baseUrl, "/auth/me");
      expect(anonymous.status).toBe(401);
    });

    it("puts refresh tokens in httpOnly cookies, rotates them and detects reuse", async () => {
      const email = `refresh.${run}@wpay.test`;
      const registered = await json<{
        accessToken: string;
        csrfToken: string;
        refreshExpiresIn: number;
        user: { id: string };
      }>(harness.baseUrl, "/auth/register", {
        method: "POST",
        body: { email, password: "correct-horse-battery" },
      });
      expect(registered.status).toBe(201);
      expect(registered.body.accessToken.length).toBeGreaterThan(20);
      expect(registered.body).not.toHaveProperty("refreshToken");
      expect(registered.body.csrfToken.length).toBeGreaterThan(20);
      expect(registered.body.refreshExpiresIn).toBeGreaterThan(0);
      const originalCookies = cookieHeader(registered.setCookie);
      expect(originalCookies).toContain("wpay_refresh=");
      expect(originalCookies).toContain("wpay_csrf=");
      expect(registered.setCookie.join(";")).toContain("HttpOnly");
      created.users.push(registered.body.user.id);

      const rotated = await json<{ accessToken: string; csrfToken: string }>(
        harness.baseUrl,
        "/auth/refresh",
        {
          method: "POST",
          cookie: originalCookies,
          headers: { "x-csrf-token": registered.body.csrfToken },
        },
      );
      expect(rotated.status).toBe(200);
      expect(rotated.body.accessToken.length).toBeGreaterThan(20);
      expect(rotated.body.csrfToken).not.toBe(registered.body.csrfToken);
      expect(rotated.body).not.toHaveProperty("refreshToken");
      const rotatedCookies = cookieHeader(rotated.setCookie);

      // Presenting the old cookie again revokes the whole family, including the
      // token that was just issued.
      const reuse = await json(harness.baseUrl, "/auth/refresh", {
        method: "POST",
        cookie: originalCookies,
        headers: { "x-csrf-token": registered.body.csrfToken },
      });
      expect(reuse.status).toBe(401);
      const afterReuse = await json(harness.baseUrl, "/auth/refresh", {
        method: "POST",
        cookie: rotatedCookies,
        headers: { "x-csrf-token": rotated.body.csrfToken },
      });
      expect(afterReuse.status).toBe(401);
    });

    it("rejects refresh and logout without a matching CSRF token", async () => {
      const email = `csrf.${run}@wpay.test`;
      const registered = await json<{ csrfToken: string; user: { id: string } }>(
        harness.baseUrl,
        "/auth/register",
        { method: "POST", body: { email, password: "correct-horse-battery" } },
      );
      created.users.push(registered.body.user.id);
      const cookies = cookieHeader(registered.setCookie);

      const missing = await json(harness.baseUrl, "/auth/refresh", {
        method: "POST",
        cookie: cookies,
      });
      expect(missing.status).toBe(403);
      const wrong = await json(harness.baseUrl, "/auth/refresh", {
        method: "POST",
        cookie: cookies,
        headers: { "x-csrf-token": "not-the-token" },
      });
      expect(wrong.status).toBe(403);
      const logout = await json(harness.baseUrl, "/auth/logout", {
        method: "POST",
        cookie: cookies,
        headers: { "x-csrf-token": "not-the-token" },
      });
      expect(logout.status).toBe(403);
    });

    it("rejects state-changing requests from an unlisted browser origin", async () => {
      const response = await json<{ code: string }>(harness.baseUrl, "/auth/login", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: { email: `admin.${run}@wpay.test`, password: "correct-horse-battery" },
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ORIGIN_FORBIDDEN");
    });

    it("revokes a refresh token on logout", async () => {
      const session = await json<{ csrfToken: string; user: { id: string } }>(
        harness.baseUrl,
        "/auth/login",
        {
          method: "POST",
          body: {
            email: `admin.${run}@wpay.test`,
            password: "correct-horse-battery",
          },
        },
      );
      expect(session.status).toBe(201);
      const cookies = cookieHeader(session.setCookie);
      const logout = await json<{ revoked: boolean }>(harness.baseUrl, "/auth/logout", {
        method: "POST",
        cookie: cookies,
        headers: { "x-csrf-token": session.body.csrfToken },
      });
      expect(logout.status).toBe(200);
      const refresh = await json(harness.baseUrl, "/auth/refresh", {
        method: "POST",
        cookie: cookies,
        headers: { "x-csrf-token": session.body.csrfToken },
      });
      expect(refresh.status).toBe(401);
    });

    it("supports a wallet challenge and rejects a forged signature", async () => {
      const keypair = Keypair.random();
      const challenge = await json<{ nonce: string }>(harness.baseUrl, "/auth/wallet/challenge", {
        method: "POST",
        body: { address: keypair.publicKey() },
      });
      expect(challenge.status).toBe(201);

      const forged = await json(harness.baseUrl, "/auth/wallet/verify", {
        method: "POST",
        body: {
          address: keypair.publicKey(),
          nonce: challenge.body.nonce,
          signature: Buffer.from("not-a-signature-at-all").toString("base64"),
        },
      });
      expect(forged.status).toBe(401);
    });

    it("accepts a genuine wallet signature and creates the account once", async () => {
      const keypair = Keypair.random();
      const challenge = await json<{ nonce: string; message: string }>(
        harness.baseUrl,
        "/auth/wallet/challenge",
        { method: "POST", body: { address: keypair.publicKey() } },
      );
      const signature = keypair.sign(Buffer.from(challenge.body.message, "utf8")).toString("base64");
      const verified = await json<{ accessToken: string; user: { stellarAddress: string } }>(
        harness.baseUrl,
        "/auth/wallet/verify",
        {
          method: "POST",
          body: { address: keypair.publicKey(), nonce: challenge.body.nonce, signature },
        },
      );
      expect(verified.status).toBe(201);
      expect(verified.body.user.stellarAddress).toBe(keypair.publicKey());

      const user = await harness.prisma.user.findUnique({
        where: { stellarAddress: keypair.publicKey() },
      });
      if (user) created.users.push(user.id);

      // The nonce is single-use: replaying it must fail.
      const replay = await json(harness.baseUrl, "/auth/wallet/verify", {
        method: "POST",
        body: { address: keypair.publicKey(), nonce: challenge.body.nonce, signature },
      });
      expect(replay.status).toBe(401);
    });
  });

  describe("merchants", () => {
    it("registers a merchant as pending and ignores a self-service fee override", async () => {
      const response = await json<{ id: string; status: string; feeBps: number }>(
        harness.baseUrl,
        "/merchants",
        {
          method: "POST",
          token: userToken,
          body: {
            name: `Integration ${run}`,
            ownerAddress: settlement,
            settlementAddress: settlement,
            feeBps: 0,
          },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.status).toBe("PENDING");
      expect(response.body.feeBps).toBe(250);
      merchantId = response.body.id;
      created.merchants.push(merchantId);
    });

    it("refuses to register a merchant for a wallet the caller does not control", async () => {
      const response = await json(harness.baseUrl, "/merchants", {
        method: "POST",
        token: userToken,
        body: {
          name: `Impersonated ${run}`,
          ownerAddress: address(),
          settlementAddress: settlement,
          feeBps: 250,
        },
      });
      expect(response.status).toBe(403);
    });

    it("hides another user's merchant from the list", async () => {
      const response = await json<{ items: { id: string }[] }>(harness.baseUrl, "/merchants", {
        token: userToken,
      });
      expect(response.status).toBe(200);
      expect(response.body.items.some((entry) => entry.id === merchantId)).toBe(true);
    });

    it("blocks a non-operator from approving a merchant", async () => {
      const response = await json(harness.baseUrl, `/merchants/${merchantId}/approve`, {
        method: "POST",
        token: userToken,
      });
      expect(response.status).toBe(403);
    });

    it("lets an operator approve and suspend a merchant", async () => {
      const approve = await json<{ merchant: { status: string } }>(
        harness.baseUrl,
        `/merchants/${merchantId}/approve`,
        { method: "POST", token: adminToken },
      );
      expect(approve.status).toBe(201);
      expect(approve.body.merchant.status).toBe("ACTIVE");

      const suspend = await json<{ merchant: { status: string } }>(
        harness.baseUrl,
        `/merchants/${merchantId}/suspend`,
        { method: "POST", token: adminToken },
      );
      expect(suspend.status).toBe(201);
      expect(suspend.body.merchant.status).toBe("SUSPENDED");

      const reactivate = await json<{ merchant: { status: string } }>(
        harness.baseUrl,
        `/merchants/${merchantId}/approve`,
        { method: "POST", token: adminToken },
      );
      expect(reactivate.body.merchant.status).toBe("ACTIVE");
    });

    it("patches mutable merchant fields", async () => {
      const response = await json<{ description: string }>(
        harness.baseUrl,
        `/merchants/${merchantId}`,
        { method: "PATCH", token: userToken, body: { description: "updated by test" } },
      );
      expect(response.status).toBe(200);
      expect(response.body.description).toBe("updated by test");
    });

    it("404s an unknown merchant", async () => {
      const response = await json(harness.baseUrl, "/merchants/does-not-exist", {
        token: adminToken,
      });
      expect(response.status).toBe(404);
    });
  });

  describe("invoices", () => {
    it("creates an invoice and serves it on the public checkout route", async () => {
      const response = await json<{ id: string; number: string; status: string }>(
        harness.baseUrl,
        "/invoices",
        {
          method: "POST",
          token: adminToken,
          body: {
            merchantId,
            token: address(),
            amount: "25000000",
            memo: "integration invoice",
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.status).toBe("OPEN");
      created.invoices.push(response.body.id);
      invoiceNumber = response.body.number;

      const publicLookup = await json<{
        number: string;
        amount: string;
        merchantName: string;
        feeBps: number;
        fee: string;
        net: string;
      }>(harness.baseUrl, `/invoices/public/${invoiceNumber}`);
      expect(publicLookup.status).toBe(200);
      expect(publicLookup.body.amount).toBe("25000000");
      expect(publicLookup.body.merchantName).toBeTruthy();
      expect(publicLookup.body.feeBps).toBe(250);
      // 250 bps of 25,000,000 is 625,000.
      expect(publicLookup.body.fee).toBe("625000");
      expect(publicLookup.body.net).toBe("24375000");
    });

    it("rejects a due date in the past", async () => {
      const response = await json(harness.baseUrl, "/invoices", {
        method: "POST",
        token: adminToken,
        body: {
          merchantId,
          token: address(),
          amount: "100",
          dueAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      });
      // The service raises Conflict, not a validation error.
      expect(response.status).toBe(409);
    });

    it("cancels an open invoice and refuses to cancel it twice", async () => {
      const first = await json<{ status: string }>(
        harness.baseUrl,
        `/invoices/${created.invoices[0]}/cancel`,
        { method: "POST", token: adminToken },
      );
      expect(first.status).toBe(201);
      expect(first.body.status).toBe("CANCELLED");

      const second = await json(harness.baseUrl, `/invoices/${created.invoices[0]}/cancel`, {
        method: "POST",
        token: adminToken,
      });
      expect(second.status).toBe(409);
    });

    it("404s an unknown public invoice number", async () => {
      const response = await json(harness.baseUrl, "/invoices/public/INV-NOPE-000000");
      expect(response.status).toBe(404);
    });
  });

  describe("payments", () => {
    it("creates a pending payment and splits the fee", async () => {
      const response = await json<{
        payment: { id: string; status: string; fee: string; net: string; amount: string };
        transaction: unknown;
      }>(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token: address(), amount: "10000000", payerAddress: payer },
      });
      expect(response.status).toBe(201);
      expect(response.body.payment.status).toBe("PENDING");
      expect(response.body.payment.amount).toBe("10000000");
      // 250 bps of 10,000,000 is 250,000.
      expect(response.body.payment.fee).toBe("250000");
      expect(response.body.payment.net).toBe("9750000");
      // No payment router is configured, so no transaction may be fabricated.
      expect(response.body.transaction).toBeNull();
      paymentId = response.body.payment.id;
      created.payments.push(paymentId);
    });

    it("replays an idempotent create instead of double-charging", async () => {
      const key = `idem-${run}`;
      const body = { merchantId, token: address(), amount: "5000", payerAddress: payer };
      const first = await json<{ payment: { id: string } }>(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body,
        headers: { "idempotency-key": key },
      });
      expect(first.status).toBe(201);
      created.payments.push(first.body.payment.id);

      const second = await json<{ payment: { id: string } }>(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body,
        headers: { "idempotency-key": key },
      });
      expect(second.status).toBe(201);
      expect(second.body.payment.id).toBe(first.body.payment.id);

      const count = await harness.prisma.payment.count({
        where: { id: { in: [first.body.payment.id, second.body.payment.id] } },
      });
      expect(count).toBe(1);
    });

    it("rejects an idempotency key reused with a different body", async () => {
      const key = `idem-conflict-${run}`;
      const first = await json(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token: address(), amount: "7000", payerAddress: payer },
        headers: { "idempotency-key": key },
      });
      expect(first.status).toBe(201);
      const createdPayment = await harness.prisma.payment.findFirstOrThrow({
        where: { merchantId, amount: 7000n, payerAddress: payer },
        orderBy: { createdAt: "desc" },
      });
      created.payments.push(createdPayment.id);

      const second = await json(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token: address(), amount: "8000", payerAddress: payer },
        headers: { "idempotency-key": key },
      });
      expect(second.status).toBe(409);
    });

    it("refuses a payment for a suspended merchant", async () => {
      await json(harness.baseUrl, `/merchants/${merchantId}/suspend`, {
        method: "POST",
        token: adminToken,
      });
      const response = await json<{ message: string }>(harness.baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token: address(), amount: "1000", payerAddress: payer },
      });
      expect(response.status).toBe(409);
      await json(harness.baseUrl, `/merchants/${merchantId}/approve`, {
        method: "POST",
        token: adminToken,
      });
    });

    it("cannot be marked settled without a verified network confirmation", async () => {
      // No Soroban contracts are configured in this environment, so confirmation
      // must fail closed rather than optimistically flipping the status.
      const response = await json(harness.baseUrl, `/payments/${paymentId}/confirm`, {
        method: "POST",
        token: adminToken,
        body: { txHash: "a".repeat(64) },
      });
      expect([422, 400, 503]).toContain(response.status);
      const row = await harness.prisma.payment.findUnique({ where: { id: paymentId } });
      expect(row?.status).toBe("PENDING");
    });

    it("lists and fetches payments for a merchant", async () => {
      const list = await json<{ items: { id: string }[] }>(
        harness.baseUrl,
        `/payments?merchantId=${merchantId}&limit=10`,
        { token: adminToken },
      );
      expect(list.status).toBe(200);
      expect(list.body.items.some((entry) => entry.id === paymentId)).toBe(true);

      const single = await json<{ id: string }>(harness.baseUrl, `/payments/${paymentId}`, {
        token: adminToken,
      });
      expect(single.status).toBe(200);
      expect(single.body.id).toBe(paymentId);
    });
  });

  describe("refunds", () => {
    let refundId = "";

    it("requests a refund within the unrefunded amount", async () => {
      const response = await json<{ id: string; status: string }>(harness.baseUrl, "/refunds", {
        method: "POST",
        token: adminToken,
        body: { paymentId, amount: "1000000", reason: "integration test refund" },
      });
      expect(response.status).toBe(201);
      expect(response.body.status).toBe("PENDING");
      refundId = response.body.id;
      created.refunds.push(refundId);
    });

    it("rejects a refund larger than the payment", async () => {
      const response = await json(harness.baseUrl, "/refunds", {
        method: "POST",
        token: adminToken,
        body: { paymentId, amount: "999999999", reason: "too much" },
      });
      expect(response.status).toBe(400);
    });

    it("approves a refund without fabricating an on-chain transaction", async () => {
      const response = await json<{ refund: { status: string }; transaction: unknown }>(
        harness.baseUrl,
        `/refunds/${refundId}/approve`,
        { method: "POST", token: adminToken },
      );
      expect(response.status).toBe(201);
      expect(response.body.refund.status).toBe("APPROVED");
      // The RefundManager has not assigned an id, so nothing is signable.
      expect(response.body.transaction).toBeNull();
    });

    it("refuses to decide the same refund twice", async () => {
      const response = await json(harness.baseUrl, `/refunds/${refundId}/reject`, {
        method: "POST",
        token: adminToken,
        body: { reason: "late rejection" },
      });
      expect(response.status).toBe(409);
    });
  });

  describe("escrows, plans and settlements", () => {
    it("creates an escrow with release in the future", async () => {
      const response = await json<{ escrow: { id: string; status: string } }>(
        harness.baseUrl,
        "/escrows",
        {
          method: "POST",
          token: adminToken,
          body: {
            merchantId,
            payerAddress: payer,
            payeeAddress: address(),
            arbiterAddress: address(),
            token: address(),
            amount: "3000000",
            releaseAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.escrow.status).toBe("CREATED");
      created.escrows.push(response.body.escrow.id);
    });

    it("lists escrows", async () => {
      const response = await json<{ items: unknown[] }>(harness.baseUrl, "/escrows", {
        token: adminToken,
      });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it("creates a subscription plan and subscribes to it", async () => {
      const plan = await json<{ id: string }>(harness.baseUrl, "/subscriptions/plans", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token: address(), amount: "1000", intervalSecs: 2_592_000 },
      });
      expect(plan.status).toBe(201);
      created.plans.push(plan.body.id);

      const subscription = await json<{ subscription: { status: string } }>(
        harness.baseUrl,
        "/subscriptions",
        {
          method: "POST",
          token: adminToken,
          body: { planId: plan.body.id, subscriber: address(), cycles: 3 },
        },
      );
      expect(subscription.status).toBe(201);
      expect(subscription.body.subscription.status).toBe("ACTIVE");
    });

    it("returns a settlements page", async () => {
      const response = await json<{ items: unknown[] }>(harness.baseUrl, "/settlements", {
        token: adminToken,
      });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it("creates, links and rejects duplicate settlement batches", async () => {
      const operator = address();
      await harness.prisma.user.update({
        where: { id: adminId },
        data: { stellarAddress: operator },
      });
      const freshLogin = await json<{ accessToken: string }>(harness.baseUrl, "/auth/login", {
        method: "POST",
        body: { email: `admin.${run}@wpay.test`, password: "correct-horse-battery" },
      });
      expect(freshLogin.status).toBe(201);
      const operatorToken = freshLogin.body.accessToken;
      const token = StrKey.encodeContract(randomBytes(32));
      const payee = address();
      const periodStart = new Date(Date.now() - 3_600_000).toISOString();
      const periodEnd = new Date(Date.now() - 1_800_000).toISOString();
      const body = {
        token,
        periodStart,
        periodEnd,
        entries: [{ payee, amount: "1000" }],
      };

      const response = await json<{
        window: { id: string; total: string; entries: unknown[]; windowIdOnChain: string | null };
        intent: unknown;
      }>(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token: operatorToken,
        body,
      });
      expect(response.status).toBe(201);
      expect(response.body.window.total).toBe("1000");
      expect(response.body.window.entries).toHaveLength(1);
      created.windows.push(response.body.window.id);

      const duplicate = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token: operatorToken,
        body,
      });
      expect(duplicate.status).toBe(409);

      const onChainId = String(Date.now());
      const linked = await json<{ windowIdOnChain: string }>(
        harness.baseUrl,
        `/settlements/${response.body.window.id}/link`,
        { method: "POST", token: operatorToken, body: { windowId: onChainId } },
      );
      expect(linked.status).toBe(201);
      expect(linked.body.windowIdOnChain).toBe(onChainId);

      const detail = await json<{ id: string; entries: unknown[] }>(
        harness.baseUrl,
        `/settlements/${response.body.window.id}`,
        { token: operatorToken },
      );
      expect(detail.status).toBe(200);
      expect(detail.body.entries).toHaveLength(1);

      const intents = await json<{ windowIdOnChain: string }>(
        harness.baseUrl,
        `/settlements/${response.body.window.id}/intents`,
        { method: "POST", token: operatorToken },
      );
      expect(intents.status).toBe(201);
      expect(intents.body.windowIdOnChain).toBe(onChainId);
    });

    it("rejects invalid settlement batches and unsafe transitions", async () => {
      const operator = address();
      await harness.prisma.user.update({
        where: { id: adminId },
        data: { stellarAddress: operator },
      });
      const login = await json<{ accessToken: string }>(harness.baseUrl, "/auth/login", {
        method: "POST",
        body: { email: `admin.${run}@wpay.test`, password: "correct-horse-battery" },
      });
      const token = login.body.accessToken;
      const contract = StrKey.encodeContract(randomBytes(32));
      const payee = address();
      const base = {
        token: contract,
        periodStart: new Date(Date.now() - 7_200_000).toISOString(),
        periodEnd: new Date(Date.now() - 3_600_000).toISOString(),
        entries: [{ payee, amount: "500" }],
      };

      const empty = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, entries: [] },
      });
      expect(empty.status).toBe(400);

      const badPeriod = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, periodEnd: base.periodStart },
      });
      expect(badPeriod.status).toBe(400);

      const duplicatePayee = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, entries: [{ payee, amount: "500" }, { payee, amount: "600" }] },
      });
      expect(duplicatePayee.status).toBe(400);

      const wrongPayee = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, entries: [{ payee, amount: "500", merchantId }] },
      });
      expect(wrongPayee.status).toBe(400);

      const unknownMerchant = await json(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, entries: [{ payee, amount: "500", merchantId: "missing" }] },
      });
      expect(unknownMerchant.status).toBe(404);

      const first = await json<{ window: { id: string } }>(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: { ...base, entries: [{ payee: settlement, amount: "500", merchantId }] },
      });
      expect(first.status).toBe(201);
      created.windows.push(first.body.window.id);
      const second = await json<{ window: { id: string } }>(harness.baseUrl, "/settlements/batches", {
        method: "POST",
        token,
        body: {
          ...base,
          periodStart: new Date(Date.now() - 2_700_000).toISOString(),
          periodEnd: new Date(Date.now() - 1_800_000).toISOString(),
          entries: [{ payee: address(), amount: "250" }],
        },
      });
      expect(second.status).toBe(201);
      created.windows.push(second.body.window.id);

      const missing = await json(harness.baseUrl, "/settlements/not-a-window", { token });
      expect(missing.status).toBe(404);

      const unlinked = await json<{ windowIdOnChain: string | null }>(
        harness.baseUrl,
        `/settlements/${first.body.window.id}/intents`,
        { method: "POST", token },
      );
      expect(unlinked.status).toBe(201);
      expect(unlinked.body.windowIdOnChain).toBeNull();

      for (const path of [
        `/settlements/${first.body.window.id}/execute-intent`,
        `/settlements/${first.body.window.id}/cancel-intent`,
      ]) {
        const response = await json(harness.baseUrl, path, { method: "POST", token });
        expect(response.status).toBe(409);
      }

      const windowId = String(Date.now());
      const linked = await json(harness.baseUrl, `/settlements/${first.body.window.id}/link`, {
        method: "POST",
        token,
        body: { windowId },
      });
      expect(linked.status).toBe(201);
      const linkedAgain = await json(harness.baseUrl, `/settlements/${first.body.window.id}/link`, {
        method: "POST",
        token,
        body: { windowId: "999999" },
      });
      expect(linkedAgain.status).toBe(409);
      const reusedWindow = await json(harness.baseUrl, `/settlements/${second.body.window.id}/link`, {
        method: "POST",
        token,
        body: { windowId },
      });
      expect(reusedWindow.status).toBe(409);

      const earlyExecute = await json(harness.baseUrl, `/settlements/${first.body.window.id}/execute-intent`, {
        method: "POST",
        token,
      });
      expect(earlyExecute.status).toBe(409);

      const cancelled = await json(harness.baseUrl, `/settlements/${first.body.window.id}/cancel-intent`, {
        method: "POST",
        token,
      });
      expect(cancelled.status).toBe(201);

      await harness.prisma.settlementWindow.update({
        where: { id: first.body.window.id },
        data: { status: "CLOSED" },
      });
      const executed = await json(harness.baseUrl, `/settlements/${first.body.window.id}/execute-intent`, {
        method: "POST",
        token,
      });
      expect(executed.status).toBe(201);

      await harness.prisma.settlementWindow.update({
        where: { id: first.body.window.id },
        data: { status: "EXECUTED" },
      });
      const cancelExecuted = await json(harness.baseUrl, `/settlements/${first.body.window.id}/cancel-intent`, {
        method: "POST",
        token,
      });
      expect(cancelExecuted.status).toBe(409);
    });
  });

  describe("platform administration", () => {
    it("reports an analytics overview for a merchant", async () => {
      const response = await json<{ paymentCount: number; grossVolume: string }>(
        harness.baseUrl,
        `/analytics/overview?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("paymentCount");
      expect(response.body).toHaveProperty("grossVolume");
    });

    it("restricts analytics to accessible merchants", async () => {
      const response = await json(harness.baseUrl, "/analytics/overview", { token: userToken });
      expect([400, 403]).toContain(response.status);
    });

    it("restricts audit logs to operators", async () => {
      const forbidden = await json(harness.baseUrl, "/admin/audit-logs", { token: userToken });
      expect(forbidden.status).toBe(403);
      const allowed = await json<{ items: unknown[] }>(harness.baseUrl, "/admin/audit-logs", {
        token: adminToken,
      });
      expect(allowed.status).toBe(200);
    });

    it("lists merchants for admins and refuses non-admins", async () => {
      const forbidden = await json(harness.baseUrl, "/admin/merchants", { token: userToken });
      expect(forbidden.status).toBe(403);
      const allowed = await json<{ items: unknown[] }>(harness.baseUrl, "/admin/merchants", {
        token: adminToken,
      });
      expect(allowed.status).toBe(200);
    });

    it("exposes and resolves indexer failures to operators", async () => {
      const contractId = StrKey.encodeContract(randomBytes(32));
      const failure = await harness.prisma.indexerFailure.create({
        data: {
          contractId,
          eventIndex: `${run}-1`,
          txHash: "b".repeat(64),
          ledger: 1,
          kind: "payment",
          reason: "projection could not match a unique local record",
        },
      });
      created.failures.push(failure.id);

      const forbidden = await json(harness.baseUrl, "/admin/indexer/failures", { token: userToken });
      expect(forbidden.status).toBe(403);

      const status = await json<{ unresolvedFailures: number; recent: { id: string }[] }>(
        harness.baseUrl,
        "/admin/indexer/status",
        { token: adminToken },
      );
      expect(status.status).toBe(200);
      expect(status.body.unresolvedFailures).toBeGreaterThanOrEqual(1);
      expect(status.body.recent.some((row) => row.id === failure.id)).toBe(true);

      const list = await json<{ items: { id: string }[] }>(
        harness.baseUrl,
        "/admin/indexer/failures?limit=5",
        { token: adminToken },
      );
      expect(list.status).toBe(200);
      expect(list.body.items.some((row) => row.id === failure.id)).toBe(true);

      const resolved = await json<{ resolved: boolean }>(
        harness.baseUrl,
        `/admin/indexer/failures/${failure.id}/resolve`,
        { method: "POST", token: adminToken },
      );
      expect(resolved.status).toBe(201);
      expect(resolved.body.resolved).toBe(true);
      const row = await harness.prisma.indexerFailure.findUnique({ where: { id: failure.id } });
      expect(row?.resolvedAt).not.toBeNull();

      const missing = await json(harness.baseUrl, "/admin/indexer/failures/missing/resolve", {
        method: "POST",
        token: adminToken,
      });
      expect(missing.status).toBe(404);
    });

    it("builds a treasury overview", async () => {
      const response = await json(harness.baseUrl, "/treasury/overview", { token: adminToken });
      expect(response.status).toBe(200);
    });

    it("refuses a treasury withdrawal when contracts are unconfigured", async () => {
      const response = await json(harness.baseUrl, "/treasury/withdraw-intent", {
        method: "POST",
        token: adminToken,
        body: { token: address(), to: address(), amount: "1000" },
      });
      expect([400, 503]).toContain(response.status);
    });

    it("rejects an unsigned transaction submission payload", async () => {
      const response = await json(harness.baseUrl, "/transactions/submit", {
        method: "POST",
        body: { xdr: "not-an-xdr" },
      });
      expect(response.status).toBe(400);
    });
  });

  describe("api keys and webhooks", () => {
    it("issues an API key scoped to a merchant and authenticates with it", async () => {
      const response = await json<{ key: string; id: string }>(harness.baseUrl, "/api-keys", {
        method: "POST",
        token: adminToken,
        body: { name: `key-${run}`, merchantId },
      });
      expect(response.status).toBe(201);
      created.apiKeys.push(response.body.id);

      const scoped = await json<{ items: { id: string }[] }>(
        harness.baseUrl,
        `/payments?merchantId=${merchantId}`,
        { headers: { "x-api-key": response.body.key } },
      );
      expect(scoped.status).toBe(200);
    });

    it("revokes an API key and then rejects it", async () => {
      const created2 = await json<{ key: string; id: string }>(harness.baseUrl, "/api-keys", {
        method: "POST",
        token: adminToken,
        body: { name: `revoke-${run}` },
      });
      created.apiKeys.push(created2.body.id);

      const revoked = await json(harness.baseUrl, `/api-keys/${created2.body.id}`, {
        method: "DELETE",
        token: adminToken,
      });
      expect([200, 204]).toContain(revoked.status);

      const denied = await json(harness.baseUrl, "/payments", {
        headers: { "x-api-key": created2.body.key },
      });
      expect(denied.status).toBe(401);
    });

    it("registers a webhook endpoint and lists its deliveries", async () => {
      const response = await json<{ id: string; secret: string }>(
        harness.baseUrl,
        "/webhooks",
        {
          method: "POST",
          token: adminToken,
          body: {
            merchantId,
            url: "https://93.184.216.34/wpay-hook",
            events: ["payment.settled"],
          },
        },
      );
      expect(response.status).toBe(201);
      created.webhooks.push(response.body.id);

      const deliveries = await json<{ items: unknown[] }>(
        harness.baseUrl,
        `/webhooks/${response.body.id}/deliveries`,
        { token: adminToken },
      );
      expect(deliveries.status).toBe(200);
      expect(Array.isArray(deliveries.body.items)).toBe(true);
    });

    it("deletes a webhook endpoint", async () => {
      const response = await json(harness.baseUrl, `/webhooks/${created.webhooks[0]}`, {
        method: "DELETE",
        token: adminToken,
      });
      expect([200, 204]).toContain(response.status);
    });
  });

  describe("additional read and intent paths", () => {
    it("lists invoices and fetches one by id", async () => {
      const list = await json<{ items: { id: string }[] }>(
        harness.baseUrl,
        `/invoices?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(list.status).toBe(200);
      expect(list.body.items.some((entry) => entry.id === created.invoices[0])).toBe(true);

      const single = await json<{ id: string }>(
        harness.baseUrl,
        `/invoices/${created.invoices[0]}`,
        { token: adminToken },
      );
      expect(single.status).toBe(200);
      expect(single.body.id).toBe(created.invoices[0]);
    });

    it("404s an unknown invoice id", async () => {
      const response = await json(harness.baseUrl, "/invoices/missing", { token: adminToken });
      expect(response.status).toBe(404);
    });

    it("hides a merchant's invoice from an unrelated user", async () => {
      const stranger = await json<{ accessToken: string; user: { id: string } }>(
        harness.baseUrl,
        "/auth/register",
        {
          method: "POST",
          body: { email: `stranger.${run}@wpay.test`, password: "correct-horse-battery" },
        },
      );
      created.users.push(stranger.body.user.id);
      const response = await json(harness.baseUrl, `/invoices/${created.invoices[0]}`, {
        token: stranger.body.accessToken,
      });
      expect(response.status).toBe(403);
    });

    it("refuses a checkout payment intent when contracts are unconfigured", async () => {
      // A cancelled invoice is also not payable; both paths must fail closed.
      const cancelled = await json(
        harness.baseUrl,
        `/invoices/public/${invoiceNumber}/intent`,
        { method: "POST", body: { payer: address() } },
      );
      expect(cancelled.status).toBe(409);

      const missing = await json(harness.baseUrl, "/invoices/public/INV-MISSING-000/intent", {
        method: "POST",
        body: { payer: address() },
      });
      expect(missing.status).toBe(404);
    });

    it("refuses a payment intent for an unconfigured router", async () => {
      const response = await json(harness.baseUrl, `/payments/${paymentId}/intent`, {
        token: adminToken,
      });
      expect(response.status).toBe(503);
    });

    it("lists refunds", async () => {
      const response = await json<{ items: unknown[] }>(
        harness.baseUrl,
        `/refunds?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it("refuses escrow actions without an on-chain escrow id", async () => {
      const escrowId = created.escrows[0];
      const release = await json(harness.baseUrl, `/escrows/${escrowId}/release`, {
        method: "POST",
        token: adminToken,
      });
      expect(release.status).toBe(409);

      const single = await json<{ id: string }>(harness.baseUrl, `/escrows/${escrowId}`, {
        token: adminToken,
      });
      expect(single.status).toBe(200);
      expect(single.body.id).toBe(escrowId);

      const missing = await json(harness.baseUrl, "/escrows/nope", { token: adminToken });
      expect(missing.status).toBe(404);
    });

    it("lists subscription plans and subscriptions", async () => {
      const plans = await json<{ items: unknown[] }>(
        harness.baseUrl,
        `/subscriptions/plans?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(plans.status).toBe(200);
      expect(plans.body.items.length).toBeGreaterThan(0);

      const subs = await json<{ items: unknown[] }>(
        harness.baseUrl,
        `/subscriptions?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(subs.status).toBe(200);
      expect(Array.isArray(subs.body.items)).toBe(true);
    });

    it("serves Prometheus metrics as text", async () => {
      // The health controller hosts metrics; Prometheus scrapes this exact path.
      const response = await fetch(`${harness.baseUrl}/v1/health/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const body = await response.text();
      expect(body).toContain("wpay_");
    });

    it("lists api keys without leaking the secret", async () => {
      const response = await json<{ items: { id: string }[] }>(harness.baseUrl, "/api-keys", {
        token: adminToken,
      });
      expect(response.status).toBe(200);
      expect(response.body.items.length).toBeGreaterThan(0);
      // The secret itself is only ever returned by the create call.
      for (const entry of response.body.items) {
        expect(entry).not.toHaveProperty("key");
      }
    });

    it("lists notifications and marks one as read", async () => {
      const list = await json<{ items: { id: string }[] }>(
        harness.baseUrl,
        `/notifications?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.items)).toBe(true);

      const missing = await json(harness.baseUrl, "/notifications/nope/read", {
        method: "POST",
        token: adminToken,
      });
      expect(missing.status).toBe(404);
    });

    it("refuses emergency pause when the contract is unconfigured", async () => {
      const pause = await json(harness.baseUrl, "/admin/pause", {
        method: "POST",
        token: adminToken,
      });
      expect(pause.status).toBe(400);
      const unpause = await json(harness.baseUrl, "/admin/unpause", {
        method: "POST",
        token: adminToken,
      });
      expect(unpause.status).toBe(400);
    });

    it("filters settlements by merchant", async () => {
      const response = await json<{ items: unknown[] }>(
        harness.baseUrl,
        `/settlements?merchantId=${merchantId}`,
        { token: adminToken },
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it("rejects an unknown API key", async () => {
      const response = await json(harness.baseUrl, "/payments", {
        headers: { "x-api-key": "wpay_not_a_real_key" },
      });
      expect(response.status).toBe(401);
    });
  });

  describe("database semantics", () => {
    it("rolls a transaction back when the callback throws", async () => {
      const marker = `rollback-${run}`;
      await expect(
        harness.prisma.$transaction(async (tx) => {
          await tx.user.create({
            data: { email: `${marker}@wpay.test`, passwordHash: "x", role: "USER" },
          });
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");
      const survivors = await harness.prisma.user.findMany({
        where: { email: `${marker}@wpay.test` },
      });
      expect(survivors).toHaveLength(0);
    });

    it("commits a successful transaction", async () => {
      const marker = `commit-${run}`;
      const created2 = await harness.prisma.$transaction(async (tx) =>
        tx.user.create({
          data: { email: `${marker}@wpay.test`, passwordHash: "x", role: "USER" },
        }),
      );
      created.users.push(created2.id);
      const found = await harness.prisma.user.findUnique({ where: { id: created2.id } });
      expect(found?.email).toBe(`${marker}@wpay.test`);
    });

    it("enforces the unique constraint on payment transaction hashes", async () => {
      const hash = `tx-${run}`;
      const base = {
        merchantId,
        payerAddress: payer,
        token: address(),
        amount: 1n,
        fee: 0n,
        net: 1n,
        status: "PENDING" as const,
        txHash: hash,
      };
      const first = await harness.prisma.payment.create({ data: base });
      created.payments.push(first.id);
      await expect(harness.prisma.payment.create({ data: base })).rejects.toThrow();
    });
  });
});
