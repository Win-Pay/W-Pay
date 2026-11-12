import {
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
import { randomBytes } from "node:crypto";
import {
  CreateInvoiceSchema,
  type CreateInvoiceInput,
  type InvoiceRecord,
  type TransactionIntent,
} from "@wpay/types";
import { clampPageSize } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
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
  async publicInvoice(number: string): Promise<InvoiceRecord> {
    const row = await this.prisma.invoice.findUnique({ where: { number } });
    if (!row) throw new NotFoundException("invoice not found");
    return { ...toInvoiceRecord(row), customerEmail: null, paymentId: null };
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

  /** Builds the payment intent a customer wallet signs to pay this invoice. */
  async payIntent(number: string): Promise<TransactionIntent> {
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
    const intent = await this.soroban.paymentIntent({
      payer: row.merchant.ownerAddress,
      merchantId: row.merchant.registryId ?? 0n,
      token: row.token,
      amount: row.amount,
      memo: row.memo ?? row.number,
    });
    if (!intent) throw new ConflictException("unable to build invoice payment");
    return intent;
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
  payIntent(@Param("number") number: string) {
    return this.invoices.payIntent(number);
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
