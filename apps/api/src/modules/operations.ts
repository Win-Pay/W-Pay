import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CreateEscrowSchema,
  CreatePlanSchema,
  RequestRefundSchema,
  SubscribeSchema,
  type CreateEscrowInput,
  type CreatePlanInput,
  type EscrowRecord,
  type RefundRecord,
  type RequestRefundInput,
  type SubscribeInput,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type TransactionIntent,
} from "@wpay/types";
import { clampPageSize } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
import { PrismaService } from "../prisma.service";
import { SorobanService } from "../soroban.service";
import { AuditService } from "../audit.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { WebhooksModule } from "../webhooks/webhooks.controller";
import {
  CurrentUser,
  Roles,
  ZodPipe,
  requireMerchantAccess,
  type AuthUser,
} from "../common";

/* ------------------------------------------------------------------ */
/* Escrows                                                             */
/* ------------------------------------------------------------------ */

type EscrowRow = {
  id: string;
  merchantId: string;
  payerAddress: string;
  payeeAddress: string;
  arbiterAddress: string;
  token: string;
  amount: bigint;
  releaseAt: Date;
  status: string;
  contractEscrowId: bigint | null;
  createdAt: Date;
};

function toEscrow(row: EscrowRow): EscrowRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    payerAddress: row.payerAddress,
    payeeAddress: row.payeeAddress,
    arbiterAddress: row.arbiterAddress,
    token: row.token,
    amount: row.amount.toString(),
    releaseAt: row.releaseAt.toISOString(),
    status: row.status as EscrowRecord["status"],
    contractEscrowId: row.contractEscrowId?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class EscrowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthUser,
    input: CreateEscrowInput,
  ): Promise<{ escrow: EscrowRecord; transaction: TransactionIntent | null }> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);
    if (input.releaseAt.getTime() <= Date.now()) {
      throw new BadRequestException("releaseAt must be in the future");
    }
    const row = await this.prisma.escrow.create({
      data: {
        merchantId: merchant.id,
        payerAddress: input.payerAddress,
        payeeAddress: input.payeeAddress,
        arbiterAddress: input.arbiterAddress,
        token: input.token,
        amount: BigInt(input.amount),
        releaseAt: input.releaseAt,
        status: "CREATED",
      },
    });
    const transaction = await this.soroban.escrowIntent({
      payer: input.payerAddress,
      payee: input.payeeAddress,
      arbiter: input.arbiterAddress,
      token: input.token,
      amount: BigInt(input.amount),
      releaseAt: Math.floor(input.releaseAt.getTime() / 1000),
    });
    await this.audit.record(user, "escrow.created", "Escrow", row.id, { amount: input.amount });
    return { escrow: toEscrow(row), transaction };
  }

  async list(
    user: AuthUser,
    query: { merchantId?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<{ items: EscrowRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.escrow.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.status ? { status: query.status as EscrowRecord["status"] } : {}),
        ...(staff
          ? {}
          : {
              merchant: user.viaApiKey
                ? { id: user.scopedMerchantId ?? undefined }
                : { ownerUserId: user.id },
            }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map(toEscrow);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  async get(user: AuthUser, id: string): Promise<EscrowRecord> {
    const row = await this.prisma.escrow.findUnique({ where: { id }, include: { merchant: true } });
    if (!row) throw new NotFoundException("escrow not found");
    requireMerchantAccess(user, row.merchant);
    return toEscrow(row);
  }

  /** Builds the wallet-signed action for an escrow transition. */
  async action(
    user: AuthUser,
    id: string,
    action: "release" | "refund" | "dispute" | "resolve",
    resolveToPayee = true,
  ): Promise<TransactionIntent> {
    const row = await this.prisma.escrow.findUnique({ where: { id }, include: { merchant: true } });
    if (!row) throw new NotFoundException("escrow not found");
    requireMerchantAccess(user, row.merchant);
    if (!row.contractEscrowId) throw new ConflictException("escrow has no on-chain id");
    const caller = user.stellarAddress ?? row.payerAddress;
    const intent =
      action === "release"
        ? await this.soroban.releaseEscrowIntent(caller, row.contractEscrowId)
        : action === "refund"
          ? await this.soroban.refundEscrowIntent(caller, row.contractEscrowId)
          : action === "dispute"
            ? await this.soroban.disputeEscrowIntent(caller, row.contractEscrowId)
            : await this.soroban.resolveEscrowIntent(caller, row.contractEscrowId, resolveToPayee);
    if (!intent) throw new ConflictException("unable to build escrow transaction");
    await this.audit.record(user, `escrow.${action}`, "Escrow", id, {});
    return intent;
  }
}

@ApiTags("escrows")
@Controller("escrows")
export class EscrowsController {
  constructor(private readonly escrows: EscrowsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreateEscrowSchema)) input: CreateEscrowInput,
  ) {
    return this.escrows.create(user, input);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; status?: string; limit?: string; cursor?: string },
  ) {
    return this.escrows.list(user, {
      merchantId: query.merchantId,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.escrows.get(user, id);
  }

  @Post(":id/release")
  release(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.escrows.action(user, id, "release");
  }

  @Post(":id/refund")
  refund(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.escrows.action(user, id, "refund");
  }

  @Post(":id/dispute")
  dispute(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.escrows.action(user, id, "dispute");
  }

  @Roles("OPERATOR")
  @Post(":id/resolve")
  resolve(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: { releaseToPayee?: boolean },
  ) {
    return this.escrows.action(user, id, "resolve", body.releaseToPayee ?? true);
  }
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

type RefundRow = {
  id: string;
  paymentId: string;
  merchantId: string;
  payerAddress: string;
  amount: bigint;
  reason: string;
  status: string;
  contractRefundId: bigint | null;
  txHash: string | null;
  createdAt: Date;
  decidedAt: Date | null;
};

function toRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    merchantId: row.merchantId,
    payerAddress: row.payerAddress,
    amount: row.amount.toString(),
    reason: row.reason,
    status: row.status as RefundRecord["status"],
    contractRefundId: row.contractRefundId?.toString() ?? null,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
  ) {}

  async request(user: AuthUser, input: RequestRefundInput): Promise<RefundRecord> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: { merchant: true },
    });
    if (!payment) throw new NotFoundException("payment not found");
    const isPayer = user.stellarAddress !== null && payment.payerAddress === user.stellarAddress;
    if (!isPayer) requireMerchantAccess(user, payment.merchant);
    const remaining = payment.amount - payment.refunded;
    if (BigInt(input.amount) > remaining) {
      throw new BadRequestException("refund exceeds the unrefunded amount");
    }
    const row = await this.prisma.refund.create({
      data: {
        paymentId: payment.id,
        merchantId: payment.merchantId,
        payerAddress: payment.payerAddress,
        amount: BigInt(input.amount),
        reason: input.reason,
        status: "PENDING",
      },
    });
    await this.audit.record(user, "refund.requested", "Refund", row.id, { amount: input.amount });
    await this.webhooks.enqueueForMerchant(payment.merchantId, "refund.requested", {
      refundId: row.id,
      paymentId: payment.id,
      amount: input.amount,
    });
    return toRefund(row);
  }

  async list(
    user: AuthUser,
    query: { merchantId?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<{ items: RefundRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.refund.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.status ? { status: query.status as RefundRecord["status"] } : {}),
        ...(staff
          ? {}
          : {
              merchant: user.viaApiKey
                ? { id: user.scopedMerchantId ?? undefined }
                : { ownerUserId: user.id },
            }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map(toRefund);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  /**
   * Builds the RefundManager.request transaction. Only the payer can sign it,
   * and only after the underlying payment has an on-chain id.
   */
  async requestIntent(user: AuthUser, id: string): Promise<TransactionIntent> {
    const row = await this.prisma.refund.findUnique({
      where: { id },
      include: { payment: true },
    });
    if (!row) throw new NotFoundException("refund not found");
    if (row.status !== "PENDING") throw new ConflictException("refund is already decided");
    if (row.contractRefundId) throw new ConflictException("refund is already on chain");
    if (!row.payment.contractPaymentId) {
      throw new ConflictException("payment has no on-chain id");
    }
    if (user.stellarAddress !== row.payerAddress) {
      throw new ConflictException("only the refund payer can request it on chain");
    }
    const intent = await this.soroban.requestRefundIntent({
      payer: row.payerAddress,
      paymentId: row.payment.contractPaymentId,
      amount: row.amount,
      reason: row.reason,
    });
    if (!intent) throw new ConflictException("unable to build refund request");
    await this.audit.record(user, "refund.request_intent", "Refund", id, {});
    return intent;
  }

  /** Returns the transaction the settlement wallet must sign, and marks intent. */
  async approve(
    user: AuthUser,
    id: string,
  ): Promise<{ refund: RefundRecord; transaction: TransactionIntent | null }> {
    const row = await this.prisma.refund.findUnique({
      where: { id },
      include: { merchant: true, payment: true },
    });
    if (!row) throw new NotFoundException("refund not found");
    if (row.status !== "PENDING") throw new ConflictException("refund is already decided");
    if (user.stellarAddress && user.stellarAddress !== row.merchant.settlementAddress) {
      throw new ConflictException("only the settlement wallet can approve this refund");
    }
    if (
      !user.viaApiKey &&
      user.role !== "ADMIN" &&
      user.role !== "OPERATOR" &&
      user.stellarAddress !== row.merchant.settlementAddress
    ) {
      throw new ConflictException("only the settlement wallet can approve this refund");
    }
    // Refund ids are assigned by the RefundManager contract; the indexer links
    // them back to this record. Without that link there is nothing to sign and
    // no transaction is fabricated.
    const transaction = row.contractRefundId
      ? await this.soroban.approveRefundIntent(
          row.merchant.settlementAddress,
          row.contractRefundId,
        )
      : null;
    if (row.contractRefundId && !transaction) {
      throw new ConflictException("unable to build the on-chain refund approval");
    }
    const updated = await this.prisma.refund.update({
      where: { id },
      data: { status: "APPROVED", decidedAt: new Date() },
    });
    await this.audit.record(user, "refund.approved", "Refund", id, {});
    await this.webhooks.enqueueForMerchant(row.merchantId, "refund.approved", {
      refundId: id,
      paymentId: row.paymentId,
      amount: row.amount.toString(),
    });
    return { refund: toRefund(updated), transaction };
  }

  async reject(user: AuthUser, id: string, reason: string): Promise<RefundRecord> {
    const row = await this.prisma.refund.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("refund not found");
    if (row.status !== "PENDING") throw new ConflictException("refund is already decided");
    requireMerchantAccess(user, row.merchant);
    const updated = await this.prisma.refund.update({
      where: { id },
      data: { status: "REJECTED", decidedAt: new Date(), reason: `${row.reason} (rejected: ${reason})` },
    });
    await this.audit.record(user, "refund.rejected", "Refund", id, { reason });
    return toRefund(updated);
  }
}

@ApiTags("refunds")
@Controller("refunds")
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  request(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(RequestRefundSchema)) input: RequestRefundInput,
  ) {
    return this.refunds.request(user, input);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; status?: string; limit?: string; cursor?: string },
  ) {
    return this.refunds.list(user, {
      merchantId: query.merchantId,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Post(":id/intent")
  requestIntent(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.refunds.requestIntent(user, id);
  }

  @Post(":id/approve")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.refunds.approve(user, id);
  }

  @Post(":id/reject")
  reject(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    return this.refunds.reject(user, id, body.reason ?? "no reason given");
  }
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

type PlanRow = {
  id: string;
  merchantId: string;
  token: string;
  amount: bigint;
  intervalSecs: number;
  active: boolean;
  planIdOnChain: bigint | null;
  createdAt: Date;
};

function toPlan(row: PlanRow): SubscriptionPlanRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    token: row.token,
    amount: row.amount.toString(),
    intervalSecs: row.intervalSecs,
    active: row.active,
    planIdOnChain: row.planIdOnChain?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

type SubscriptionRow = {
  id: string;
  planId: string;
  subscriber: string;
  prepaid: bigint;
  cyclesCharged: number;
  nextDueAt: Date;
  status: string;
  createdAt: Date;
};

function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    planId: row.planId,
    subscriber: row.subscriber,
    prepaid: row.prepaid.toString(),
    cyclesCharged: row.cyclesCharged,
    nextDueAt: row.nextDueAt.toISOString(),
    status: row.status as SubscriptionRecord["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
  ) {}

  async createPlan(
    user: AuthUser,
    input: CreatePlanInput,
  ): Promise<SubscriptionPlanRecord & { transaction: TransactionIntent | null }> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);
    if (merchant.status !== "ACTIVE") throw new ConflictException("merchant is not active");
    const row = await this.prisma.subscriptionPlan.create({
      data: {
        merchantId: merchant.id,
        token: input.token,
        amount: BigInt(input.amount),
        intervalSecs: input.intervalSecs,
        active: true,
        // Filled from the SubscriptionManager "plan" event by the indexer.
        planIdOnChain: undefined,
      },
    });
    const owner = user.stellarAddress ?? merchant.ownerAddress;
    const transaction = merchant.registryId
      ? await this.soroban.createPlanIntent({
          owner,
          merchantId: merchant.registryId,
          token: input.token,
          amount: BigInt(input.amount),
          intervalSecs: input.intervalSecs,
        })
      : null;
    await this.audit.record(user, "subscription.plan_created", "SubscriptionPlan", row.id, {});
    return { ...toPlan(row), transaction };
  }

  async listPlans(merchantId: string): Promise<{ items: SubscriptionPlanRecord[]; nextCursor: null }> {
    const rows = await this.prisma.subscriptionPlan.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { items: rows.map(toPlan), nextCursor: null };
  }

  async subscribe(
    user: AuthUser,
    input: SubscribeInput,
  ): Promise<{ subscription: SubscriptionRecord; transaction: TransactionIntent | null }> {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: input.planId },
      include: { merchant: true },
    });
    if (!plan) throw new NotFoundException("plan not found");
    if (!plan.active) throw new ConflictException("plan is not active");
    if (plan.merchant.status !== "ACTIVE") throw new ConflictException("merchant is not active");
    if (user.stellarAddress && user.stellarAddress !== input.subscriber) {
      throw new ConflictException("subscriber must match the authenticated wallet");
    }
    const row = await this.prisma.subscription.create({
      data: {
        planId: plan.id,
        subscriber: input.subscriber,
        prepaid: plan.amount * BigInt(input.cycles),
        cyclesCharged: 0,
        nextDueAt: new Date(Date.now() + plan.intervalSecs * 1000),
        status: "ACTIVE",
      },
    });
    const transaction = plan.planIdOnChain
      ? await this.soroban.subscribeIntent({
          subscriber: input.subscriber,
          planId: plan.planIdOnChain,
          cycles: input.cycles,
        })
      : null;
    await this.audit.record(user, "subscription.created", "Subscription", row.id, {});
    return { subscription: toSubscription(row), transaction };
  }

  async list(
    user: AuthUser,
    query: { merchantId?: string; subscriber?: string; limit?: number; cursor?: string },
  ): Promise<{ items: SubscriptionRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.subscription.findMany({
      where: {
        ...(query.subscriber ? { subscriber: query.subscriber } : {}),
        ...(query.merchantId
          ? { plan: { merchantId: query.merchantId } }
          : staff
            ? {}
            : user.viaApiKey
              ? { plan: { merchantId: user.scopedMerchantId ?? undefined } }
              : { plan: { merchant: { ownerUserId: user.id } } }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map(toSubscription);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  async cancelIntent(user: AuthUser, id: string): Promise<TransactionIntent> {
    const row = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!row) throw new NotFoundException("subscription not found");
    if (user.stellarAddress && user.stellarAddress !== row.subscriber) {
      throw new ConflictException("only the subscriber can cancel");
    }
    if (!row.contractSubId) throw new ConflictException("subscription has no on-chain id");
    const intent = await this.soroban.cancelSubscriptionIntent(row.subscriber, row.contractSubId);
    if (!intent) throw new ConflictException("unable to build cancellation");
    await this.audit.record(user, "subscription.cancel_requested", "Subscription", id, {});
    return intent;
  }
}

@ApiTags("subscriptions")
@Controller("subscriptions")
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post("plans")
  createPlan(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreatePlanSchema)) input: CreatePlanInput,
  ) {
    return this.subscriptions.createPlan(user, input);
  }

  @Get("plans")
  listPlans(@Query("merchantId") merchantId: string) {
    if (!merchantId) throw new BadRequestException("merchantId is required");
    return this.subscriptions.listPlans(merchantId);
  }

  @Post()
  subscribe(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(SubscribeSchema)) input: SubscribeInput,
  ) {
    return this.subscriptions.subscribe(user, input);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; subscriber?: string; limit?: string; cursor?: string },
  ) {
    return this.subscriptions.list(user, {
      merchantId: query.merchantId,
      subscriber: query.subscriber,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.subscriptions.cancelIntent(user, id);
  }
}

@Module({
  imports: [WebhooksModule],
  controllers: [EscrowsController, RefundsController, SubscriptionsController],
  providers: [EscrowsService, RefundsService, SubscriptionsService],
  exports: [EscrowsService, RefundsService, SubscriptionsService],
})
export class OperationsModule {}
