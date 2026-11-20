import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CreateMerchantSchema,
  UpdateMerchantSchema,
  UpdateMerchantSettlementSchema,
  type CreateMerchantInput,
  type MerchantRecord,
  type TransactionIntent,
  type UpdateMerchantInput,
  type UpdateMerchantSettlementInput,
  type UserRole,
} from "@wpay/types";
import { clampPageSize } from "@wpay/config";
import { encodeCursor } from "@wpay/shared";
import { PrismaService } from "../prisma.service";
import { SorobanService } from "../soroban.service";
import { AuditService } from "../audit.service";
import {
  CurrentUser,
  Roles,
  ZodPipe,
  requireMerchantAccess,
  type AuthUser,
} from "../common";

type MerchantRow = {
  id: string;
  registryId: bigint | null;
  name: string;
  ownerAddress: string;
  settlementAddress: string;
  feeBps: number;
  status: string;
  website: string | null;
  description: string | null;
  createdAt: Date;
};

export function toMerchantRecord(row: MerchantRow): MerchantRecord {
  return {
    id: row.id,
    registryId: row.registryId?.toString() ?? null,
    name: row.name,
    ownerAddress: row.ownerAddress,
    settlementAddress: row.settlementAddress,
    feeBps: row.feeBps,
    status: row.status as MerchantRecord["status"],
    website: row.website,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, input: CreateMerchantInput): Promise<MerchantRecord> {
    const isStaff = user.role === "ADMIN" || user.role === "OPERATOR";
    if (!isStaff && (!user.stellarAddress || user.stellarAddress !== input.ownerAddress)) {
      throw new ForbiddenException(
        "ownerAddress must match the Stellar wallet authenticated for this account",
      );
    }
    const existing = await this.prisma.merchant.findUnique({
      where: { ownerAddress: input.ownerAddress },
    });
    if (existing) throw new ConflictException("address already registered as a merchant");
    const row = await this.prisma.merchant.create({
      data: {
        name: input.name,
        ownerAddress: input.ownerAddress,
        settlementAddress: input.settlementAddress,
        // Self-service merchants cannot choose their own fee; only staff may
        // override the platform rate.
        feeBps: isStaff ? input.feeBps : 250,
        website: input.website ?? null,
        description: input.description ?? null,
        status: "PENDING",
        ownerUserId: user.id,
      },
    });
    await this.audit.record(user, "merchant.created", "Merchant", row.id, { name: row.name });
    return toMerchantRecord(row);
  }

  async list(
    user: AuthUser,
    query: { status?: string; limit?: number; cursor?: string },
  ): Promise<{ items: MerchantRecord[]; nextCursor: string | null }> {
    const limit = clampPageSize(query.limit);
    const isStaff = user.role === "ADMIN" || user.role === "OPERATOR";
    const rows = await this.prisma.merchant.findMany({
      where: {
        ...(query.status ? { status: query.status as MerchantRecord["status"] } : {}),
        ...(isStaff
          ? {}
          : { ownerUserId: user.id }),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map(toMerchantRecord);
    return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!.id) : null };
  }

  async get(user: AuthUser, id: string): Promise<MerchantRecord> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, row);
    return toMerchantRecord(row);
  }

  async update(user: AuthUser, id: string, input: UpdateMerchantInput): Promise<MerchantRecord> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, row);
    if (input.settlementAddress && row.registryId !== null) {
      throw new ConflictException(
        "settlement address is controlled on chain; use the settlement intent route",
      );
    }
    const updated = await this.prisma.merchant.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.settlementAddress ? { settlementAddress: input.settlementAddress } : {}),
        ...(input.website !== undefined ? { website: input.website } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    await this.audit.record(user, "merchant.updated", "Merchant", id, input);
    return toMerchantRecord(updated);
  }

  async setStatus(
    user: AuthUser,
    id: string,
    status: "ACTIVE" | "SUSPENDED",
  ): Promise<{ merchant: MerchantRecord; transaction: TransactionIntent | null }> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("merchant not found");
    if (status === "ACTIVE" && row.status !== "PENDING" && row.status !== "SUSPENDED") {
      throw new ConflictException(`cannot activate a ${row.status.toLowerCase()} merchant`);
    }
    if (status === "SUSPENDED" && row.status !== "ACTIVE") {
      throw new ConflictException(`cannot suspend a ${row.status.toLowerCase()} merchant`);
    }

    if (row.registryId !== null) {
      // The registry is the source of truth: leave the projection untouched
      // until the indexer observes the signed approval/suspension event.
      const caller = user.stellarAddress ?? row.ownerAddress;
      const transaction =
        status === "SUSPENDED"
          ? await this.soroban.suspendMerchantIntent(caller, row.registryId)
          : row.status === "SUSPENDED"
            ? await this.soroban.reactivateMerchantIntent(caller, row.registryId)
            : await this.soroban.approveMerchantIntent(caller, row.registryId);
      if (!transaction) {
        throw new ConflictException("merchant registry is not configured for this deployment");
      }
      await this.audit.record(user, `merchant.${status.toLowerCase()}_requested`, "Merchant", id, {
        registryId: row.registryId.toString(),
      });
      return { merchant: toMerchantRecord(row), transaction };
    }

    const updated = await this.prisma.merchant.update({ where: { id }, data: { status } });
    await this.audit.record(user, `merchant.${status.toLowerCase()}`, "Merchant", id, {});
    return { merchant: toMerchantRecord(updated), transaction: null };
  }

  async settlementIntent(
    user: AuthUser,
    id: string,
    input: UpdateMerchantSettlementInput,
  ): Promise<TransactionIntent> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("merchant not found");
    requireMerchantAccess(user, row);
    if (row.registryId === null) {
      throw new ConflictException("merchant is not registered on chain yet");
    }
    const transaction = await this.soroban.updateMerchantSettlementIntent(
      row.ownerAddress,
      row.registryId,
      input.settlementAddress,
    );
    if (!transaction) {
      throw new ConflictException("merchant registry is not configured for this deployment");
    }
    await this.audit.record(user, "merchant.settlement_requested", "Merchant", id, {
      settlementAddress: input.settlementAddress,
    });
    return transaction;
  }
}

@ApiTags("merchants")
@Controller("merchants")
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreateMerchantSchema)) input: CreateMerchantInput,
  ): Promise<MerchantRecord> {
    return this.merchants.create(user, input);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: { status?: string; limit?: string; cursor?: string },
  ): Promise<{ items: MerchantRecord[]; nextCursor: string | null }> {
    return this.merchants.list(user, {
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
    });
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<MerchantRecord> {
    return this.merchants.get(user, id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodPipe(UpdateMerchantSchema)) input: UpdateMerchantInput,
  ): Promise<MerchantRecord> {
    return this.merchants.update(user, id, input);
  }

  @Roles("OPERATOR" as UserRole)
  @Post(":id/approve")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.merchants.setStatus(user, id, "ACTIVE");
  }

  @Roles("OPERATOR" as UserRole)
  @Post(":id/suspend")
  suspend(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.merchants.setStatus(user, id, "SUSPENDED");
  }

  @Post(":id/settlement-intent")
  settlementIntent(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodPipe(UpdateMerchantSettlementSchema)) input: UpdateMerchantSettlementInput,
  ): Promise<TransactionIntent> {
    return this.merchants.settlementIntent(user, id, input);
  }
}

@Module({
  controllers: [MerchantsController],
  providers: [MerchantsService],
  exports: [MerchantsService],
})
export class MerchantsModule {}
