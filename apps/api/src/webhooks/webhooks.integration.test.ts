/**
 * Webhook delivery integration tests. A real HTTP server stands in for the
 * merchant endpoint, so signatures, retries and dead-lettering are exercised
 * end to end against PostgreSQL and the production delivery code.
 *
 * Skipped without DATABASE_URL, like the other database suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyWebhook } from "@wpay/shared";
import type { PrismaClient } from "@wpay/database";
import { WebhooksService } from "./webhooks.service";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const run = `wh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface Captured {
  body: string;
  signature: string;
  timestamp: string;
}

describe.skipIf(!hasDatabase)("webhook delivery", () => {
  let prisma: PrismaClient;
  let service: WebhooksService;
  let server: Server;
  let baseUrl = "";
  let merchantId = "";
  let userId = "";

  /** Responses the fake merchant endpoint returns, in order. */
  let responses: number[] = [200];
  const captured: Captured[] = [];

  beforeAll(async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = "2";
    ({ prisma } = await import("@wpay/database"));

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured.push({
          body: Buffer.concat(chunks).toString("utf8"),
          signature: String(request.headers["x-wpay-signature"] ?? ""),
          timestamp: String(request.headers["x-wpay-timestamp"] ?? ""),
        });
        const status = responses.shift() ?? 500;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ received: status < 300 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    service = new WebhooksService(prisma as never);
    // The worker timer is started by Nest's lifecycle hook, not by us.
    expect(service.maxAttempts).toBe(2);

    const owner = await prisma.user.create({
      data: { email: `webhook.${run}@wpay.test`, passwordHash: "x", role: "USER" },
    });
    userId = owner.id;
    const merchant = await prisma.merchant.create({
      data: {
        name: `Webhook ${run}`,
        ownerAddress: Keypair.random().publicKey(),
        settlementAddress: Keypair.random().publicKey(),
        ownerUserId: owner.id,
        status: "ACTIVE",
      },
    });
    merchantId = merchant.id;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.webhookDelivery.deleteMany({ where: { endpoint: { merchantId } } });
    await prisma.webhookEndpoint.deleteMany({ where: { merchantId } });
    await prisma.merchant.deleteMany({ where: { id: merchantId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 60_000);

  // Every test starts with an empty delivery queue so the scripted HTTP
  // responses and drain() counts belong to that test alone.
  beforeEach(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { endpoint: { merchantId } } });
    await prisma.webhookEndpoint.deleteMany({ where: { merchantId } });
    responses = [];
    captured.length = 0;
  });

  async function endpoint(events: string[] = ["payment.settled"]) {
    const row = await prisma.webhookEndpoint.create({
      data: {
        merchantId,
        url: `${baseUrl}/hook`,
        secret: `whsec_${run}${Math.random().toString(36).slice(2, 10)}`,
        events,
        active: true,
      },
    });
    return row;
  }

  it("only queues deliveries for endpoints subscribed to the event", async () => {
    const subscribed = await endpoint(["payment.settled"]);
    await endpoint(["refund.approved"]);

    await service.enqueueForMerchant(merchantId, "payment.settled", { paymentId: "p1" });

    const queued = await prisma.webhookDelivery.findMany({
      where: { endpoint: { merchantId } },
      select: { endpointId: true, status: true },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.endpointId).toBe(subscribed.id);
    expect(queued[0]!.status).toBe("PENDING");
  });

  it("delivers with an HMAC signature the merchant can verify", async () => {
    const target = await endpoint();
    responses = [200];
    captured.length = 0;
    await service.enqueueForMerchant(merchantId, "payment.settled", { paymentId: "abc" });

    const delivered = await service.drain();
    expect(delivered).toBeGreaterThanOrEqual(1);

    // The most recent capture belongs to this endpoint's delivery.
    const last = captured[captured.length - 1]!;
    const body = JSON.parse(last.body) as { event: string; data: { paymentId: string } };
    expect(body.event).toBe("payment.settled");
    expect(body.data.paymentId).toBe("abc");

    await expect(
      verifyWebhook({
        body: last.body,
        secret: target.secret,
        signature: last.signature,
        timestamp: last.timestamp,
      }),
    ).resolves.toBe(true);

    // A different secret must not verify.
    await expect(
      verifyWebhook({
        body: last.body,
        secret: "whsec_wrong",
        signature: last.signature,
        timestamp: last.timestamp,
      }),
    ).resolves.toBe(false);

    // A tampered body must not verify either.
    await expect(
      verifyWebhook({
        body: last.body.replace("abc", "xyz"),
        secret: target.secret,
        signature: last.signature,
        timestamp: last.timestamp,
      }),
    ).resolves.toBe(false);

    const delivery = await prisma.webhookDelivery.findFirst({
      where: { endpointId: target.id },
    });
    expect(delivery?.status).toBe("DELIVERED");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.responseStatus).toBe(200);
    expect(delivery?.deliveredAt).toBeInstanceOf(Date);
  });

  it("retries a failing endpoint and then dead-letters it", async () => {
    const target = await endpoint();
    responses = [500, 500];
    await service.enqueueForMerchant(merchantId, "payment.settled", { paymentId: "retry" });

    // First attempt fails and schedules a backoff.
    expect(await service.drain()).toBe(0);
    let delivery = await prisma.webhookDelivery.findFirst({ where: { endpointId: target.id } });
    expect(delivery?.status).toBe("PENDING");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastError).toBe("HTTP 500");

    // Simulate the backoff elapsing so the next drain picks it up again.
    await prisma.webhookDelivery.update({
      where: { id: delivery!.id },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });

    // Second attempt reaches maxAttempts and is dead-lettered as FAILED.
    expect(await service.drain()).toBe(0);
    delivery = await prisma.webhookDelivery.findFirst({ where: { endpointId: target.id } });
    expect(delivery?.status).toBe("FAILED");
    expect(delivery?.attempts).toBe(2);

    // A FAILED delivery is not picked up again by the drain loop.
    expect(await service.drain()).toBe(0);
  });

  it("requeues a dead-lettered delivery through retry()", async () => {
    const target = await endpoint();
    const row = await prisma.webhookDelivery.create({
      data: {
        endpointId: target.id,
        event: "payment.settled",
        payload: { paymentId: "dlq" },
        status: "FAILED",
        attempts: 6,
        lastError: "HTTP 500",
        nextAttemptAt: new Date(),
      },
    });

    const reset = await service.retry(
      { id: userId, role: "ADMIN", viaApiKey: false } as never,
      row.id,
    );
    expect(reset.status).toBe("PENDING");
    expect(reset.attempts).toBe(0);

    responses = [200];
    expect(await service.drain()).toBe(1);
    const after = await prisma.webhookDelivery.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("DELIVERED");
  });

  it("records a connection error as the failure reason", async () => {
    const target = await prisma.webhookEndpoint.create({
      data: {
        merchantId,
        // Port 1 is reserved and refuses connections.
        url: "http://127.0.0.1:1/hook",
        secret: `whsec_${run}dead`,
        events: ["payment.settled"],
        active: true,
      },
    });
    await service.enqueueForMerchant(merchantId, "payment.settled", { paymentId: "down" });
    await service.drain();

    const delivery = await prisma.webhookDelivery.findFirst({ where: { endpointId: target.id } });
    expect(delivery?.status).toBe("PENDING");
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastError).toBeTruthy();
    expect(delivery?.responseStatus).toBeNull();
  });
});
