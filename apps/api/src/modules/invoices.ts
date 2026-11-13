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
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { randomBytes } from "node:crypto";
import {
  ConfirmPaymentSchema,
  CreateInvoiceSchema,
  PayInvoiceIntentSchema,
  type CreateInvoiceInput,
  type InvoiceRecord,
  type PayInvoiceIntentInput,
  type PublicInvoiceRecord,
  type TransactionIntent,
} from "@wpay/types";
import { clampPageSize, splitAmount } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
import { Prisma } from "@wpay/database";
import { PrismaService } from "../prisma.service";
import { SorobanService } from "../soroban.service";
import { AuditService } from "../audit.service";
import {
  CurrentUser,
  Public,
  ZodPipe,
  requireMerchantAccess,
  type AuthUser,
} from "../common";

type InvoiceRow = {
  id: string;
  number: string;
  merchantId: string;
  token: string;
  amount: bigint;
  memo: string | null;
  status: string;
  dueAt: Date;
  paidAt: Date | null;
  paymentId: string | null;
  contractInvoiceId: bigint | null;
  contractPaymentId: bigint | null;
  txHash: string | null;
  customerEmail: string | null;
  createdAt: Date;
};

export function toInvoiceRecord(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    number: row.number,
    merchantId: row.merchantId,
    token: row.token,
    amount: row.amount.toString(),
    memo: row.memo,
    status: row.status as InvoiceRecord["status"],
    dueAt: row.dueAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    paymentId: row.paymentId,
    contractInvoiceId: row.contractInvoiceId?.toString() ?? null,
    contractPaymentId: row.contractPaymentId?.toString() ?? null,
    txHash: row.txHash,
    customerEmail: row.customerEmail,
    createdAt: row.createdAt.toISOString(),
  };
}

function invoiceNumber(): string {
  const now = new Date();
  const period = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `INV-${period}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, input: CreateInvoiceInput): Promise<InvoiceRecord> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
    if (!merchant) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, merchant);
    if (input.dueAt.getTime() <= Date.now()) {
      throw new ConflictException("dueAt must be in the future");
    }
    const row = await this.prisma.invoice.create({
      data: {
        number: invoiceNumber(),
        merchantId: merchant.id,
        token: input.token,
        amount: BigInt(input.amount),
        memo: input.memo ?? null,
        dueAt: input.dueAt,
        customerEmail: input.customerEmail ?? null,
        status: "OPEN",
      },
    });
    await this.audit.record(user, "invoice.created", "Invoice", row.id, { number: row.number });
    return toInvoiceRecord(row);
  }

  async list(
    user: AuthUser,
    query: { merchantId?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<{ items: InvoiceRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.invoice.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.status ? { status: query.status as InvoiceRecord["status"] } : {}),
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
    const items = rows.slice(0, limit).map(toInvoiceRecord);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  async get(user: AuthUser, id: string): Promise<InvoiceRecord> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("invoice not found");
    requireMerchantAccess(user, row.merchant);
    return toInvoiceRecord(row);
  }

  /** Public checkout view: no merchant-internal fields. */
  async publicInvoice(number: string): Promise<PublicInvoiceRecord> {
    const row = await this.prisma.invoice.findUnique({
      where: { number },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("invoice not found");
    const { fee, net } = splitAmount(row.amount, row.merchant.feeBps);
    return {
      ...toInvoiceRecord(row),
      customerEmail: null,
      paymentId: null,
      merchantName: row.merchant.name,
      merchantWebsite: row.merchant.website,
      merchantDescription: row.merchant.description,
      feeBps: row.merchant.feeBps,
      fee: fee.toString(),
      net: net.toString(),
    };
  }

  async cancel(user: AuthUser, id: string): Promise<InvoiceRecord> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("invoice not found");
    requireMerchantAccess(user, row.merchant);
    if (row.status !== "OPEN") throw new ConflictException("only open invoices can be cancelled");
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: "CANCELLED" } });
    await this.audit.record(user, "invoice.cancelled", "Invoice", id, {});
    return toInvoiceRecord(updated);
  }

  /** Builds the payment intent the customer's own wallet signs for this invoice. */
  async payIntent(number: string, input: PayInvoiceIntentInput): Promise<TransactionIntent> {
    const row = await this.prisma.invoice.findUnique({
      where: { number },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("invoice not found");
    if (row.status !== "OPEN") throw new ConflictException("invoice is not open");
    if (row.dueAt.getTime() < Date.now()) throw new ConflictException("invoice has expired");
    if (!this.soroban.has("paymentRouter")) {
      throw new ConflictException("Soroban contracts are not configured");
    }
    if (!row.merchant.registryId) {
      throw new ConflictException("merchant is not registered on chain");
    }

    const { fee, net } = splitAmount(row.amount, row.merchant.feeBps);
    let payment = await this.prisma.payment.findFirst({
      where: {
        merchantId: row.merchantId,
        payerAddress: input.payer,
        memo: row.number,
        amount: row.amount,
        status: "PENDING",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) {
      payment = await this.prisma.payment.create({
        data: {
          merchantId: row.merchantId,
          payerAddress: input.payer,
          token: row.token,
          amount: row.amount,
          fee,
          net,
          memo: row.number,
          status: "PENDING",
        },
      });
    }

    const intent = await this.soroban.paymentIntent({
      payer: input.payer,
      merchantId: row.merchant.registryId,
      token: row.token,
      amount: row.amount,
      memo: row.number,
    });
    if (!intent) throw new ConflictException("unable to build invoice payment");
    return { ...intent, paymentId: payment.id };
  }

  /**
   * Public checkout confirmation. Verifies the transaction against the network
   * before linking it to the invoice; the transaction must contain a
   * PaymentRouter payment for this invoice's merchant, token and amount.
   */
  async confirmPayment(number: string, txHash: string): Promise<InvoiceRecord> {
    const row = await this.prisma.invoice.findUnique({
      where: { number },
      include: { merchant: true },
    });
    if (!row) throw new NotFoundException("invoice not found");
    if (row.status === "PAID") {
      if (row.txHash === txHash) return toInvoiceRecord(row);
      throw new ConflictException("invoice was already paid by a different transaction");
    }
    if (row.status !== "OPEN") throw new ConflictException("invoice is not open");
    if (!this.soroban.configured) {
      throw new ServiceUnavailableException("Soroban contracts are not configured");
    }
    if (!row.merchant.registryId) {
      throw new ConflictException("merchant is not registered on chain");
    }

    const outcome = await this.soroban.gateway.awaitTransaction(txHash, 60_000);
    if (outcome.status !== "SUCCESS") {
      throw new BadRequestException(`transaction is not successful (${outcome.status})`);
    }
    const verified = await this.soroban.verifyPaymentTransaction(txHash, outcome.ledger, {
      merchantId: row.merchant.registryId,
      token: row.token,
      amount: row.amount,
      memo: row.number,
    });
    if (!verified) {
      throw new BadRequestException(
        "transaction does not contain a PaymentRouter payment with this invoice memo",
      );
    }
    if (
      verified.merchantId !== row.merchant.registryId ||
      verified.token !== row.token ||
      verified.amount !== row.amount ||
      verified.memo !== row.number
    ) {
      throw new BadRequestException("transaction does not match this invoice");
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        let payment = await tx.payment.findFirst({
          where: {
            OR: [{ txHash }, { contractPaymentId: verified.contractPaymentId }],
          },
        });
        if (payment?.status === "SETTLED" && payment.txHash !== txHash) {
          throw new ConflictException("transaction is already linked to another payment");
        }
        if (!payment) {
          const candidates = await tx.payment.findMany({
            where: {
              merchantId: row.merchantId,
              payerAddress: verified.payer,
              memo: row.number,
              amount: row.amount,
              status: "PENDING",
            },
            take: 2,
            orderBy: { createdAt: "desc" },
          });
          payment = candidates.length === 1 ? candidates[0]! : null;
        }
        if (payment && payment.status === "PENDING") {
          await tx.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
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
          payment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
        } else if (!payment) {
          payment = await tx.payment.create({
            data: {
              merchantId: row.merchantId,
              payerAddress: verified.payer,
              token: verified.token,
              amount: verified.amount,
              fee: verified.fee,
              net: verified.amount - verified.fee,
              memo: row.number,
              status: "SETTLED",
              txHash,
              ledger: outcome.ledger,
              contractPaymentId: verified.contractPaymentId,
              contractMerchantId: verified.merchantId,
              settledAt: new Date(),
            },
          });
        }
        return tx.invoice.update({
          where: { id: row.id },
          data: {
            status: "PAID",
            paidAt: row.paidAt ?? new Date(),
            paymentId: payment.id,
            contractPaymentId: verified.contractPaymentId,
            txHash,
          },
        });
      });
      await this.audit.record(null, "invoice.paid", "Invoice", row.id, {
        txHash,
        contractPaymentId: verified.contractPaymentId.toString(),
      });
      return toInvoiceRecord(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("transaction or contract payment id is already linked");
      }
      throw error;
    }
  }
}

@ApiTags("invoices")
@Controller("invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreateInvoiceSchema)) input: CreateInvoiceInput,
  ) {
    return this.invoices.create(user, input);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { merchantId?: string; status?: string; limit?: string; cursor?: string },
  ) {
    return this.invoices.list(user, {
      merchantId: query.merchantId,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Public()
  @Get("public/:number")
  publicInvoice(@Param("number") number: string) {
    return this.invoices.publicInvoice(number);
  }

  @Public()
  @Post("public/:number/intent")
  payIntent(
    @Param("number") number: string,
    @Body(new ZodPipe(PayInvoiceIntentSchema)) input: PayInvoiceIntentInput,
  ) {
    return this.invoices.payIntent(number, input);
  }

  @Public()
  @Post("public/:number/confirm")
  confirmPayment(
    @Param("number") number: string,
    @Body(new ZodPipe(ConfirmPaymentSchema)) input: { txHash: string },
  ) {
    return this.invoices.confirmPayment(number, input.txHash);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.invoices.get(user, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.invoices.cancel(user, id);
  }
}

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
