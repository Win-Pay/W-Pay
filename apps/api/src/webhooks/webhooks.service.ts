import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { backoffDelayMs, signWebhook } from "@wpay/shared";
import type { CreateWebhookInput, WebhookEvent } from "@wpay/types";
import { PrismaService } from "../prisma.service";
import { requireMerchantAccess, type AuthUser } from "../common";
import { allowPrivateWebhookTargets, assertSafeWebhookUrl } from "./url-guard";

const SECRET_PREFIX = "whsec_";

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger("webhooks");
  private timer?: NodeJS.Timeout;
  private running = false;
  readonly maxAttempts: number;

  constructor(private readonly prisma: PrismaService) {
    this.maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 6);
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test" || process.env.WEBHOOK_WORKER === "off") return;
    // Delivery worker runs in-process; in a multi-replica deployment the DB
    // rows are locked per attempt with a conditional update so only one worker
    // claims a delivery.
    this.timer = setInterval(() => {
      void this.drain();
    }, 5_000);
    this.timer.unref();
  }

  async create(user: AuthUser, input: CreateWebhookInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);
    await assertSafeWebhookUrl(input.url, {
      requireHttps: process.env.NODE_ENV === "production",
    });
    const secret = `${SECRET_PREFIX}${randomBytes(24).toString("hex")}`;
    const row = await this.prisma.webhookEndpoint.create({
      data: {
        merchantId: merchant.id,
        url: input.url,
        secret,
        events: input.events,
        active: true,
      },
    });
    // The secret is returned exactly once.
    return {
      id: row.id,
      merchantId: row.merchantId,
      url: row.url,
      events: row.events,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      secret,
    };
  }

  async list(user: AuthUser, merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        merchantId: row.merchantId,
        url: row.url,
        events: row.events,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const row = await this.prisma.webhookEndpoint.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("webhook not found");
    requireMerchantAccess(user, row.merchant);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  async deliveries(user: AuthUser, endpointId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
      include: { merchant: true },
    });
    if (!endpoint) throw new NotFoundException("webhook not found");
    requireMerchantAccess(user, endpoint.merchant);
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        endpointId: row.endpointId,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        responseStatus: row.responseStatus,
        lastError: row.lastError,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
      })),
      nextCursor: null,
    };
  }

  async retry(user: AuthUser, deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: { include: { merchant: true } } },
    });
    if (!delivery) throw new NotFoundException("delivery not found");
    requireMerchantAccess(user, delivery.endpoint.merchant);
    const row = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    return {
      id: row.id,
      endpointId: row.endpointId,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      responseStatus: row.responseStatus,
      lastError: row.lastError,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    };
  }

  /** Queues one delivery per active endpoint subscribed to `event`. */
  async enqueueForMerchant(
    merchantId: string,
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: { merchantId, active: true, events: { has: event } },
      });
      if (endpoints.length === 0) return;
      await this.prisma.webhookDelivery.createMany({
        data: endpoints.map((endpoint) => ({
          endpointId: endpoint.id,
          event,
          payload: payload as object,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
        })),
      });
    } catch (error) {
      this.logger.warn(`failed to enqueue ${event}: ${String(error)}`);
    }
  }

  /** Attempts all due deliveries. Safe to call repeatedly. */
  async drain(limit = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      const deliveries = await this.prisma.webhookDelivery.findMany({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
        include: { endpoint: true },
        orderBy: { nextAttemptAt: "asc" },
        take: limit,
      });
      for (const delivery of deliveries) {
        const ok = await this.attempt(delivery.id);
        if (ok) delivered += 1;
      }
    } finally {
      this.running = false;
    }
    return delivered;
  }

  private async attempt(deliveryId: string): Promise<boolean> {
    // Claim the delivery atomically so two workers cannot both send it.
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: "PENDING" },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    if (claimed.count === 0) return false;

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    if (!delivery) return false;

    const body = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      createdAt: new Date().toISOString(),
      data: delivery.payload,
    });
    const headers = await signWebhook(body, delivery.endpoint.secret);
    let status: number | undefined;
    let error: string | undefined;

    try {
      if (!allowPrivateWebhookTargets()) {
        await assertSafeWebhookUrl(delivery.endpoint.url, {
          requireHttps: process.env.NODE_ENV === "production",
        });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(process.env.WEBHOOK_TIMEOUT_MS ?? 5_000));
      const response = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: controller.signal,
        redirect: "error",
      }).finally(() => clearTimeout(timer));
      status = response.status;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    const attempts = delivery.attempts + 1;
    if (!error) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "DELIVERED",
          attempts,
          responseStatus: status,
          deliveredAt: new Date(),
          lastError: null,
        },
      });
      return true;
    }

    const failed = attempts >= this.maxAttempts;
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: failed ? "FAILED" : "PENDING",
        attempts,
        responseStatus: status,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + backoffDelayMs(attempts)),
      },
    });
    return false;
  }
}
