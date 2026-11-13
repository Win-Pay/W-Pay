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
  type CreateMerchantInput,
  type MerchantRecord,
  type UpdateMerchantInput,
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
  ): Promise<{ merchant: MerchantRecord; transaction: unknown }> {
    const row = await this.prisma.merchant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("merchant not found");
    if (status === "ACTIVE" && row.status !== "PENDING" && row.status !== "SUSPENDED") {
      throw new ConflictException(`cannot activate a ${row.status.toLowerCase()} merchant`);
    }
    const updated = await this.prisma.merchant.update({ where: { id }, data: { status } });
    await this.audit.record(user, `merchant.${status.toLowerCase()}`, "Merchant", id, {});
    const transaction =
      row.registryId && status === "ACTIVE"
        ? await this.soroban.approveMerchantIntent(user.stellarAddress ?? row.ownerAddress, row.registryId)
        : row.registryId && status === "SUSPENDED"
          ? await this.soroban.suspendMerchantIntent(user.stellarAddress ?? row.ownerAddress, row.registryId)
          : null;
    return { merchant: toMerchantRecord(updated), transaction };
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
}

@Module({
  controllers: [MerchantsController],
  providers: [MerchantsService],
  exports: [MerchantsService],
})
export class MerchantsModule {}
