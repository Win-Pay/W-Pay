import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  ConfirmPaymentSchema,
  CreatePaymentSchema,
  type CreatePaymentInput,
  type PaymentRecord,
  type TransactionIntent,
} from "@wpay/types";
import { clampPageSize, splitAmount } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
import { Prisma } from "@wpay/database";
import { PrismaService } from "../prisma.service";
import { SorobanService } from "../soroban.service";
import { AuditService } from "../audit.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { WebhooksModule } from "../webhooks/webhooks.controller";
import {
  CurrentUser,
  ZodPipe,
  requireMerchantAccess,
  type AuthUser,
} from "../common";

type PaymentRow = {
  id: string;
  merchantId: string;
  payerAddress: string;
  token: string;
  amount: bigint;
  fee: bigint;
  net: bigint;
  refunded: bigint;
  status: string;
  memo: string | null;
  txHash: string | null;
  contractPaymentId: bigint | null;
  createdAt: Date;
  settledAt: Date | null;
};

export function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    payerAddress: row.payerAddress,
    token: row.token,
    amount: row.amount.toString(),
    fee: row.fee.toString(),
    net: row.net.toString(),
    refunded: row.refunded.toString(),
    status: row.status as PaymentRecord["status"],
    memo: row.memo,
    txHash: row.txHash,
    contractPaymentId: row.contractPaymentId?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
  ) {}

  async create(
    user: AuthUser,
    input: CreatePaymentInput,
    idempotencyKey?: string,
  ): Promise<{ payment: PaymentRecord; transaction: TransactionIntent | null }> {
    const scope = `payment.create:${user.id}`;
    const requestHash = JSON.stringify(input);
    let idempotencyId: string | null = null;

    if (idempotencyKey) {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope, key: idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            "idempotency key was already used for a different request body",
          );
        }
        if (existing.response) {
          return existing.response as unknown as {
            payment: PaymentRecord;
            transaction: TransactionIntent | null;
          };
        }
        throw new ConflictException("an identical request is still being processed");
      }
      try {
        const claimed = await this.prisma.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            scope,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        idempotencyId = claimed.id;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ConflictException("an identical request is still being processed");
        }
        throw error;
      }
    }

    try {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
      if (!merchant) throw new NotFoundException("merchant not found");
      requireMerchantAccess(user, merchant);
      if (merchant.status !== "ACTIVE") {
        throw new ConflictException("merchant is not active");
      }

      const amount = BigInt(input.amount);
      const { fee, net } = splitAmount(amount, merchant.feeBps);
      const payer = input.payerAddress ?? user.stellarAddress;
      if (!payer) {
        throw new BadRequestException("payerAddress is required when the account has no wallet");
      }

      const row = await this.prisma.payment.create({
        data: {
          merchantId: merchant.id,
          payerAddress: payer,
          token: input.token,
          amount,
          fee,
          net,
          memo: input.memo ?? null,
          status: "PENDING",
        },
      });

      const transaction =
        merchant.registryId && this.soroban.has("paymentRouter")
          ? await this.soroban.paymentIntent({
              payer,
              merchantId: merchant.registryId,
              token: input.token,
              amount,
              memo: input.memo ?? "",
            })
          : null;

      const result = { payment: toPaymentRecord(row), transaction };
      if (idempotencyId) {
        await this.prisma.idempotencyKey.update({
          where: { id: idempotencyId },
          data: {
            response: JSON.parse(JSON.stringify(result)) as object,
            statusCode: 201,
          },
        });
      }
      await this.audit.record(user, "payment.created", "Payment", row.id, { amount: input.amount });
      return result;
    } catch (error) {
      if (idempotencyId) {
        await this.prisma.idempotencyKey.delete({ where: { id: idempotencyId } }).catch(() => {});
      }
      throw error;
    }
  }

  async list(
    user: AuthUser,
    query: { merchantId?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<{ items: PaymentRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.payment.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.status ? { status: query.status as PaymentRecord["status"] } : {}),
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
    const items = rows.slice(0, limit).map(toPaymentRecord);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  async get(user: AuthUser, id: string): Promise<PaymentRecord> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("payment not found");
    requireMerchantAccess(user, row.merchant);
    return toPaymentRecord(row);
  }

  async intent(user: AuthUser, id: string): Promise<TransactionIntent> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("payment not found");
    requireMerchantAccess(user, row.merchant);
    if (!this.soroban.configured) {
      throw new ServiceUnavailableException("Soroban contracts are not configured");
    }
    const intent = await this.soroban.paymentIntent({
      payer: row.payerAddress,
      merchantId: row.merchant.registryId ?? 0n,
      token: row.token,
      amount: row.amount,
      memo: row.memo ?? "",
    });
    if (!intent) throw new ServiceUnavailableException("unable to build payment transaction");
    return intent;
  }

  /**
   * Links a wallet-signed Soroban transaction to the pending payment record.
   * The network result is not enough: the PaymentRouter invocation arguments and
   * the emitted payment event must both match this payment's payer, merchant,
   * token and amount. Anything else is rejected instead of guessed.
   */
  async confirm(user: AuthUser, id: string, txHash: string): Promise<PaymentRecord> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("payment not found");
    requireMerchantAccess(user, row.merchant);
    if (row.status === "SETTLED") {
      if (row.txHash === txHash) return toPaymentRecord(row);
      throw new ConflictException("payment was already settled by a different transaction");
    }
    if (row.status !== "PENDING") throw new ConflictException("payment is already final");
    if (!this.soroban.configured) {
      throw new ServiceUnavailableException("Soroban contracts are not configured");
    }
    if (!row.merchant.registryId) {
      throw new ConflictException("merchant has no on-chain registry id");
    }

    const outcome = await this.soroban.gateway.awaitTransaction(txHash, 60_000);
    if (outcome.status !== "SUCCESS") {
      throw new BadRequestException(`transaction is not successful (${outcome.status})`);
    }
    const verified = await this.soroban.verifyPaymentTransaction(txHash, outcome.ledger, {
      payer: row.payerAddress,
      merchantId: row.merchant.registryId,
      token: row.token,
      amount: row.amount,
    });
    if (!verified) {
      throw new BadRequestException(
        "transaction does not contain a matching PaymentRouter payment for this record",
      );
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.payment.updateMany({
          where: { id, status: "PENDING" },
          data: {
            status: "SETTLED",
            txHash,
            ledger: outcome.ledger,
            contractPaymentId: verified.contractPaymentId,
            contractMerchantId: verified.merchantId,
            fee: verified.fee,
            net: verified.amount - verified.fee,
            settledAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          const current = await tx.payment.findUniqueOrThrow({ where: { id } });
          if (current.status === "SETTLED" && current.txHash === txHash) return current;
          throw new ConflictException("payment was finalised by another transaction");
        }
        const payment = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (payment.memo) {
          await tx.invoice.updateMany({
            where: { number: payment.memo, paymentId: null },
            data: {
              status: "PAID",
              paidAt: new Date(),
              paymentId: payment.id,
              contractPaymentId: verified.contractPaymentId,
              txHash,
            },
          });
        }
        await tx.invoice.updateMany({
          where: { contractPaymentId: verified.contractPaymentId, paymentId: null },
          data: {
            status: "PAID",
            paidAt: new Date(),
            paymentId: payment.id,
            txHash,
          },
        });
        return payment;
      });

      await this.audit.record(user, "payment.confirmed", "Payment", id, {
        txHash,
        contractPaymentId: verified.contractPaymentId.toString(),
      });
      await this.webhooks.enqueueForMerchant(row.merchantId, "payment.settled", {
        paymentId: id,
        merchantId: row.merchantId,
        amount: row.amount.toString(),
        txHash,
        contractPaymentId: verified.contractPaymentId.toString(),
      });
      return toPaymentRecord(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("transaction or contract payment id is already linked");
      }
      throw error;
    }
  }
}

@ApiTags("payments")
@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreatePaymentSchema)) input: CreatePaymentInput,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.payments.create(user, input, idempotencyKey);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; status?: string; limit?: string; cursor?: string },
  ) {
    return this.payments.list(user, {
      merchantId: query.merchantId,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.payments.get(user, id);
  }

  @Get(":id/intent")
  intent(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.payments.intent(user, id);
  }

  @Post(":id/confirm")
  confirm(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodPipe(ConfirmPaymentSchema)) input: { txHash: string },
  ) {
    return this.payments.confirm(user, id, input.txHash);
  }
}

@Module({
  imports: [WebhooksModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
