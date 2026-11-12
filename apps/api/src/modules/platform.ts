import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import type { TransactionIntent, UserRole } from "@wpay/types";
import { clampPageSize } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
import { Prisma, serializeBigInts } from "@wpay/database";
import { PrismaService } from "../prisma.service";
import { SorobanService } from "../soroban.service";
import { AuditService } from "../audit.service";
import { APP_CONFIG, type AppConfig } from "../config";
import {
  CurrentUser,
  Public,
  Roles,
  ZodPipe,
  generateApiKey,
  requireMerchantAccess,
  type AuthUser,
} from "../common";
import { Inject } from "@nestjs/common";

/* ------------------------------------------------------------------ */
/* Health + metrics                                                    */
/* ------------------------------------------------------------------ */

@ApiTags("health")
@Controller("health")
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async health() {
    let database: "up" | "down" = "up";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = "down";
    }
    const contracts: Record<string, boolean> = {};
    for (const name of Object.keys(this.config.contracts)) {
      contracts[name] = true;
    }
    const soroban = await this.soroban.rpcHealth();
    return {
      status: database === "up" && soroban !== "down" ? "ok" : "degraded",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: "0.1.0",
      database,
      soroban,
      contracts,
    };
  }

  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    let database = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = false;
    }
    const soroban = await this.soroban.rpcHealth();
    const ready = database && soroban !== "down";
    response.status(ready ? 200 : 503);
    return { ready, database: database ? "up" : "down", soroban };
  }

  /** Minimal Prometheus exposition; the full stack scrapes this endpoint. */
  @Public()
  @Get("/metrics")
  async metrics(@Res() response: Response): Promise<void> {
    const [payments, invoices, refunds, merchants] = await Promise.all([
      this.prisma.payment.count(),
      this.prisma.invoice.count(),
      this.prisma.refund.count(),
      this.prisma.merchant.count(),
    ]);
    const lines = [
      "# HELP wpay_payments_total Payments recorded",
      "# TYPE wpay_payments_total gauge",
      `wpay_payments_total ${payments}`,
      "# HELP wpay_invoices_total Invoices recorded",
      "# TYPE wpay_invoices_total gauge",
      `wpay_invoices_total ${invoices}`,
      "# HELP wpay_refunds_total Refunds recorded",
      "# TYPE wpay_refunds_total gauge",
      `wpay_refunds_total ${refunds}`,
      "# HELP wpay_merchants_total Merchants recorded",
      "# TYPE wpay_merchants_total gauge",
      `wpay_merchants_total ${merchants}`,
      "# HELP wpay_contracts_configured Contracts with a configured id",
      "# TYPE wpay_contracts_configured gauge",
      `wpay_contracts_configured ${Object.keys(this.config.contracts).length}`,
    ];
    response.setHeader("content-type", "text/plain; version=0.0.4");
    response.send(`${lines.join("\n")}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: AuthUser, merchantId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const payments = await this.prisma.payment.findMany({
      where: { merchantId, createdAt: { gte: since } },
      select: { amount: true, fee: true, refunded: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 5_000,
    });
    const settled = payments.filter((payment) => payment.status !== "PENDING" && payment.status !== "FAILED");
    const grossVolume = settled.reduce((sum, payment) => sum + payment.amount, 0n);
    const feesPaid = settled.reduce((sum, payment) => sum + payment.fee, 0n);
    const refundedVolume = settled.reduce((sum, payment) => sum + payment.refunded, 0n);

    const byDay = new Map<string, { volume: bigint; count: number }>();
    for (const payment of settled) {
      const date = payment.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(date) ?? { volume: 0n, count: 0 };
      bucket.volume += payment.amount;
      bucket.count += 1;
      byDay.set(date, bucket);
    }

    const pendingRefunds = await this.prisma.refund.count({
      where: { merchantId, status: "PENDING" },
    });

    return serializeBigInts({
      merchantId,
      grossVolume: grossVolume.toString(),
      feesPaid: feesPaid.toString(),
      refundedVolume: refundedVolume.toString(),
      paymentCount: payments.length,
      settledCount: settled.length,
      refundCount: settled.filter((payment) => payment.refunded > 0n).length,
      pendingRefunds,
      averagePayment: settled.length > 0 ? (grossVolume / BigInt(settled.length)).toString() : "0",
      daily: [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, bucket]) => ({ date, volume: bucket.volume.toString(), count: bucket.count })),
    });
  }
}

@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  overview(@CurrentUser() user: AuthUser, @Query("merchantId") merchantId: string) {
    if (!merchantId) throw new BadRequestException("merchantId is required");
    return this.analytics.overview(user, merchantId);
  }
}

/* ------------------------------------------------------------------ */
/* Settlements, treasury, api keys, notifications, admin               */
/* ------------------------------------------------------------------ */

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
  ) {}

  async settlements(user: AuthUser, query: { merchantId?: string; limit?: number; cursor?: string }) {
    const limit = clampPageSize(query.limit);
    const rows = await this.prisma.settlementWindow.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(user.role === "ADMIN" || user.role === "OPERATOR"
          ? {}
          : { merchant: { ownerUserId: user.id } }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      token: row.token,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      status: row.status,
      total: row.total.toString(),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null,
    };
  }

  async createSettlementBatch(
    user: AuthUser,
    input: {
      token: string;
      periodStart: string;
      periodEnd: string;
      entries: { payee: string; amount: string; merchantId?: string }[];
    },
  ) {
    if (!user.stellarAddress) {
      throw new BadRequestException("an operator wallet address is required to open a settlement window");
    }
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (!(periodStart < periodEnd)) {
      throw new BadRequestException("periodStart must be before periodEnd");
    }
    if (input.entries.length === 0 || input.entries.length > 20) {
      throw new BadRequestException("a settlement batch needs between 1 and 20 entries");
    }
    const payees = new Set<string>();
    let total = 0n;
    const entries: { payee: string; amount: bigint; merchantId: string | null }[] = [];
    for (const entry of input.entries) {
      if (payees.has(entry.payee)) {
        throw new BadRequestException(`duplicate payee ${entry.payee} in settlement batch`);
      }
      payees.add(entry.payee);
      const amount = BigInt(entry.amount);
      if (amount <= 0n) throw new BadRequestException("settlement amounts must be positive");
      if (entry.merchantId) {
        const merchant = await this.prisma.merchant.findUnique({ where: { id: entry.merchantId } });
        if (!merchant) throw new NotFoundException("merchant not found");
        if (merchant.settlementAddress !== entry.payee) {
          throw new BadRequestException("entry payee must match the merchant settlement address");
        }
      }
      total += amount;
      entries.push({ payee: entry.payee, amount, merchantId: entry.merchantId ?? null });
    }

    let window;
    try {
      window = await this.prisma.settlementWindow.create({
        data: {
          token: input.token,
          periodStart,
          periodEnd,
          total,
          entries: { create: entries },
        },
        include: { entries: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("a settlement batch already exists for this token and period");
      }
      throw error;
    }

    const intent = await this.soroban.openSettlementWindowIntent({
      operator: user.stellarAddress,
      token: input.token,
      periodStart: Math.floor(periodStart.getTime() / 1000),
      periodEnd: Math.floor(periodEnd.getTime() / 1000),
    });
    await this.audit.record(user, "settlement.batch.create", "SettlementWindow", window.id, {
      token: input.token,
      total: total.toString(),
      entries: entries.length,
    });
    return { window: settlementWindowRecord(window), intent };
  }

  async getSettlementBatch(id: string) {
    const row = await this.prisma.settlementWindow.findUnique({
      where: { id },
      include: { entries: true },
    });
    if (!row) throw new NotFoundException("settlement batch not found");
    return settlementWindowRecord(row);
  }

  /** Links an on-chain window id before the indexer observes the open event. */
  async linkSettlementWindow(user: AuthUser, id: string, windowId: string) {
    const row = await this.prisma.settlementWindow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("settlement batch not found");
    if (row.windowIdOnChain !== null) {
      throw new ConflictException("settlement batch is already linked on chain");
    }
    const onChain = BigInt(windowId);
    const clash = await this.prisma.settlementWindow.findUnique({ where: { windowIdOnChain: onChain } });
    if (clash) throw new ConflictException("that on-chain window is already linked");
    const updated = await this.prisma.settlementWindow.update({
      where: { id },
      data: { windowIdOnChain: onChain },
      include: { entries: true },
    });
    await this.audit.record(user, "settlement.batch.link", "SettlementWindow", id, { windowId });
    return settlementWindowRecord(updated);
  }

  async settlementBatchIntents(user: AuthUser, id: string) {
    if (!user.stellarAddress) throw new BadRequestException("operator wallet address is required");
    const row = await this.prisma.settlementWindow.findUnique({
      where: { id },
      include: { entries: true },
    });
    if (!row) throw new NotFoundException("settlement batch not found");
    if (row.status !== "OPEN") throw new ConflictException("settlement batch is not open");
    if (row.windowIdOnChain === null) {
      const intent = await this.soroban.openSettlementWindowIntent({
        operator: user.stellarAddress,
        token: row.token,
        periodStart: Math.floor(row.periodStart.getTime() / 1000),
        periodEnd: Math.floor(row.periodEnd.getTime() / 1000),
      });
      return { windowIdOnChain: null, intents: intent ? [intent] : [] };
    }
    const intents: TransactionIntent[] = [];
    for (const entry of row.entries.sort((a, b) => a.payee.localeCompare(b.payee))) {
      const intent = await this.soroban.addSettlementEntryIntent({
        operator: user.stellarAddress,
        windowId: row.windowIdOnChain,
        payee: entry.payee,
        amount: entry.amount,
      });
      if (intent) intents.push(intent);
    }
    const close = await this.soroban.closeSettlementWindowIntent(
      user.stellarAddress,
      row.windowIdOnChain,
    );
    if (close) intents.push(close);
    return { windowIdOnChain: row.windowIdOnChain.toString(), intents };
  }

  async executeSettlementIntent(user: AuthUser, id: string) {
    if (!user.stellarAddress) throw new BadRequestException("operator wallet address is required");
    const row = await this.prisma.settlementWindow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("settlement batch not found");
    if (row.windowIdOnChain === null) throw new ConflictException("settlement batch is not linked");
    if (row.status !== "CLOSED") throw new ConflictException("settlement batch is not closed");
    const intent = await this.soroban.executeSettlementWindowIntent(
      user.stellarAddress,
      row.windowIdOnChain,
    );
    await this.audit.record(user, "settlement.batch.execute", "SettlementWindow", id, {
      windowId: row.windowIdOnChain.toString(),
    });
    return { intent };
  }

  async cancelSettlementIntent(user: AuthUser, id: string) {
    if (!user.stellarAddress) throw new BadRequestException("admin wallet address is required");
    const row = await this.prisma.settlementWindow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("settlement batch not found");
    if (row.windowIdOnChain === null) throw new ConflictException("settlement batch is not linked");
    if (row.status === "EXECUTED") throw new ConflictException("executed batches cannot be cancelled");
    const intent = await this.soroban.cancelSettlementWindowIntent(
      user.stellarAddress,
      row.windowIdOnChain,
    );
    await this.audit.record(user, "settlement.batch.cancel", "SettlementWindow", id, {
      windowId: row.windowIdOnChain.toString(),
    });
    return { intent };
  }

  async treasuryOverview(user: AuthUser, merchantId?: string) {
    const where = merchantId ? { merchantId } : user.role === "ADMIN" ? {} : { merchant: { ownerUserId: user.id } };
    const fees = await this.prisma.payment.aggregate({
      where: { ...where, status: { in: ["SETTLED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
      _sum: { fee: true, amount: true, refunded: true },
      _count: true,
    });
    return {
      feeRevenue: (fees._sum.fee ?? 0n).toString(),
      grossVolume: (fees._sum.amount ?? 0n).toString(),
      refundedVolume: (fees._sum.refunded ?? 0n).toString(),
      paymentCount: fees._count,
      vaultConfigured: this.soroban.has("treasuryVault"),
    };
  }

  async withdrawIntent(user: AuthUser, body: { token: string; to: string; amount: string }) {
    if (user.role !== "ADMIN") throw new BadRequestException("admin role required");
    const intent = await this.soroban.withdrawIntent({
      admin: user.stellarAddress ?? body.to,
      token: body.token,
      to: body.to,
      amount: BigInt(body.amount),
    });
    if (!intent) throw new BadRequestException("treasury vault is not configured");
    await this.audit.record(user, "treasury.withdraw_intent", "TreasuryVault", null, body);
    return intent;
  }

  async createApiKey(user: AuthUser, body: { name: string; merchantId?: string }) {
    if (body.merchantId) {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: body.merchantId } });
      if (!merchant) throw new NotFoundException("merchant not found");
      requireMerchantAccess(user, merchant);
    }
    const generated = generateApiKey();
    const row = await this.prisma.apiKey.create({
      data: {
        userId: user.id,
        merchantId: body.merchantId ?? null,
        name: body.name,
        prefix: generated.prefix,
        keyHash: generated.hash,
      },
    });
    await this.audit.record(user, "api_key.created", "ApiKey", row.id, { name: body.name });
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      merchantId: row.merchantId,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      key: generated.key,
    };
  }

  async listApiKeys(user: AuthUser) {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        merchantId: row.merchantId,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
      nextCursor: null,
    };
  }

  async revokeApiKey(user: AuthUser, id: string): Promise<void> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, userId: user.id } });
    if (!row) throw new NotFoundException("api key not found");
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record(user, "api_key.revoked", "ApiKey", id, {});
  }

  async notifications(user: AuthUser, query: { merchantId?: string; unreadOnly?: boolean }) {
    const rows = await this.prisma.notification.findMany({
      where: {
        OR: [
          { userId: user.id },
          ...(query.merchantId
            ? [{ merchantId: query.merchantId }]
            : [{ merchant: { ownerUserId: user.id } }]),
        ],
        ...(query.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { items: serializeBigInts(rows), nextCursor: null };
  }

  async markRead(user: AuthUser, id: string): Promise<void> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("notification not found");
    if (row.userId && row.userId !== user.id) throw new NotFoundException("notification not found");
    await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async pauseAll(user: AuthUser): Promise<TransactionIntent> {
    const caller = requireStellarAddress(user);
    const intent = await this.soroban.pauseAllIntent(caller);
    if (!intent) throw new BadRequestException("EmergencyPause is not configured");
    await this.audit.record(user, "emergency.pause_all", "EmergencyPause", null, {});
    return intent;
  }

  async unpauseAll(user: AuthUser): Promise<TransactionIntent> {
    const caller = requireStellarAddress(user);
    const intent = await this.soroban.unpauseAllIntent(caller);
    if (!intent) throw new BadRequestException("EmergencyPause is not configured");
    await this.audit.record(user, "emergency.unpause_all", "EmergencyPause", null, {});
    return intent;
  }
}

/**
 * Emergency actions are signed by the caller's wallet, so an account without a
 * linked Stellar address cannot invoke them. Building the call with an empty
 * address used to surface as an opaque 500 from the SDK; fail with a clear 400.
 */
function requireStellarAddress(user: AuthUser): string {
  if (!user.stellarAddress) {
    throw new BadRequestException("a linked Stellar address is required for this action");
  }
  return user.stellarAddress;
}

const WithdrawSchema = z.object({
  token: z.string().min(1),
  to: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
});

const ApiKeySchema = z.object({
  name: z.string().min(1).max(60),
  merchantId: z.string().optional(),
});

@ApiTags("treasury")
@Controller("treasury")
export class TreasuryController {
  constructor(private readonly platform: PlatformService) {}

  @Get("overview")
  overview(@CurrentUser() user: AuthUser, @Query("merchantId") merchantId?: string) {
    return this.platform.treasuryOverview(user, merchantId);
  }

  @Roles("ADMIN")
  @Post("withdraw-intent")
  withdraw(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(WithdrawSchema)) body: { token: string; to: string; amount: string },
  ) {
    return this.platform.withdrawIntent(user, body);
  }
}

function settlementWindowRecord(row: {
  id: string;
  token: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  total: bigint;
  windowIdOnChain: bigint | null;
  txHash: string | null;
  createdAt: Date;
  executedAt: Date | null;
  entries: { payee: string; amount: bigint; merchantId: string | null }[];
}) {
  return {
    id: row.id,
    token: row.token,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    total: row.total.toString(),
    windowIdOnChain: row.windowIdOnChain?.toString() ?? null,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
    entries: row.entries.map((entry) => ({
      payee: entry.payee,
      amount: entry.amount.toString(),
      merchantId: entry.merchantId,
    })),
  };
}

const SettlementBatchSchema = z.object({
  token: z.string().regex(/^C[A-Z2-7]{55}$/),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  entries: z
    .array(
      z.object({
        payee: z.string().regex(/^G[A-Z2-7]{55}$/),
        amount: z.string().regex(/^[1-9][0-9]*$/),
        merchantId: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
});

const SettlementLinkSchema = z.object({ windowId: z.string().regex(/^[1-9][0-9]*$/) });

@ApiTags("settlements")
@Controller("settlements")
export class SettlementsController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; limit?: string; cursor?: string },
  ) {
    return this.platform.settlements(user, {
      merchantId: query.merchantId,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Roles("OPERATOR" as UserRole)
  @Post("batches")
  createBatch(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SettlementBatchSchema)) body: z.infer<typeof SettlementBatchSchema>) {
    return this.platform.createSettlementBatch(user, body);
  }

  @Roles("OPERATOR" as UserRole)
  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    void user;
    return this.platform.getSettlementBatch(id);
  }

  @Roles("OPERATOR" as UserRole)
  @Post(":id/link")
  link(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodPipe(SettlementLinkSchema)) body: { windowId: string },
  ) {
    return this.platform.linkSettlementWindow(user, id, body.windowId);
  }

  @Roles("OPERATOR" as UserRole)
  @Post(":id/intents")
  intents(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.platform.settlementBatchIntents(user, id);
  }

  @Roles("OPERATOR" as UserRole)
  @Post(":id/execute-intent")
  executeIntent(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.platform.executeSettlementIntent(user, id);
  }

  @Roles("ADMIN")
  @Post(":id/cancel-intent")
  cancelIntent(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.platform.cancelSettlementIntent(user, id);
  }
}

@ApiTags("api-keys")
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly platform: PlatformService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(ApiKeySchema)) body: { name: string; merchantId?: string },
  ) {
    return this.platform.createApiKey(user, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.platform.listApiKeys(user);
  }

  @Delete(":id")
  async revoke(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.platform.revokeApiKey(user, id);
    return { deleted: true };
  }
}

@ApiTags("notifications")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; unreadOnly?: string },
  ) {
    return this.platform.notifications(user, {
      merchantId: query.merchantId,
      unreadOnly: query.unreadOnly === "true",
    });
  }

  @Post(":id/read")
  async read(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.platform.markRead(user, id);
    return { read: true };
  }
}

@ApiTags("admin")
@Controller("admin")
export class AdminController {
  constructor(
    private readonly platform: PlatformService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles("ADMIN")
  @Post("pause")
  pause(@CurrentUser() user: AuthUser) {
    return this.platform.pauseAll(user);
  }

  @Roles("ADMIN")
  @Post("unpause")
  unpause(@CurrentUser() user: AuthUser) {
    return this.platform.unpauseAll(user);
  }

  @Roles("OPERATOR" as UserRole)
  @Get("audit-logs")
  auditLogs(@Query() query: { limit?: string; action?: string; entity?: string }) {
    return this.audit.list({
      limit: query.limit ? Number(query.limit) : undefined,
      action: query.action,
      entity: query.entity,
    });
  }

  @Roles("OPERATOR" as UserRole)
  @Get("indexer/status")
  async indexerStatus() {
    const [checkpoints, unresolved, recent] = await Promise.all([
      this.prisma.indexerCheckpoint.findMany({ orderBy: { contractId: "asc" } }),
      this.prisma.indexerFailure.count({ where: { resolvedAt: null } }),
      this.prisma.indexerFailure.findMany({
        where: { resolvedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
    return {
      unresolvedFailures: unresolved,
      checkpoints: checkpoints.map((row) => ({
        contractId: row.contractId,
        lastLedger: row.lastLedger,
        updatedAt: row.updatedAt.toISOString(),
      })),
      recent: recent.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        txHash: row.txHash,
        ledger: row.ledger,
        kind: row.kind,
        reason: row.reason,
        attempts: row.attempts,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Roles("OPERATOR" as UserRole)
  @Get("indexer/failures")
  async indexerFailures(@Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit ?? 50), 1), 200);
    const rows = await this.prisma.indexerFailure.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        eventIndex: row.eventIndex,
        txHash: row.txHash,
        ledger: row.ledger,
        kind: row.kind,
        reason: row.reason,
        attempts: row.attempts,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  }

  @Roles("OPERATOR" as UserRole)
  @Post("indexer/failures/:id/resolve")
  async resolveIndexerFailure(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const row = await this.prisma.indexerFailure.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("indexer failure not found");
    await this.prisma.indexerFailure.update({
      where: { id },
      data: { resolvedAt: new Date(), reason: "manually resolved by operator" },
    });
    await this.audit.record(user, "indexer.failure.resolve", "IndexerFailure", id, {
      contractId: row.contractId,
      txHash: row.txHash,
    });
    return { resolved: true };
  }

  @Roles("OPERATOR" as UserRole)
  @Get("merchants")
  async merchants(@Query("status") status?: string) {
    const rows = await this.prisma.merchant.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ownerAddress: row.ownerAddress,
        settlementAddress: row.settlementAddress,
        status: row.status,
        feeBps: row.feeBps,
        registryId: row.registryId?.toString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  }
}

const SubmitSchema = z.object({ xdr: z.string().min(32) });

/**
 * Submits a wallet-signed Soroban transaction. Public by design: the network
 * validates signatures and the payload is useless without a valid one. The
 * response reflects the final ledger status, never an optimistic success.
 */
@ApiTags("transactions")
@Controller("transactions")
export class TransactionsController {
  constructor(private readonly soroban: SorobanService) {}

  @Public()
  @Post("submit")
  submit(@Body(new ZodPipe(SubmitSchema)) body: { xdr: string }) {
    return this.soroban.submit(body.xdr);
  }
}

@Module({
  controllers: [
    HealthController,
    TransactionsController,
    AnalyticsController,
    TreasuryController,
    SettlementsController,
    ApiKeysController,
    NotificationsController,
    AdminController,
  ],
  providers: [AnalyticsService, PlatformService, AuditService],
  exports: [PlatformService],
})
export class PlatformModule {}
