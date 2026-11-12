import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import type { AuthUser } from "./common";

/** Append-only audit trail. Failures must never break the request itself. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger("audit");

  constructor(private readonly prisma: PrismaService) {}

  async record(
    actor: Pick<AuthUser, "id" | "stellarAddress"> | null,
    action: string,
    entity: string,
    entityId: string | null,
    metadata?: unknown,
    ip?: string,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actor?.id ?? null,
          actorAddress: actor?.stellarAddress ?? null,
          action,
          entity,
          entityId,
          metadata: metadata === undefined ? undefined : (metadata as object),
          ip: ip ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(`failed to write audit log for ${action}: ${String(error)}`);
    }
  }

  async list(query: { limit?: number; action?: string; entity?: string }) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.entity ? { entity: query.entity } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorAddress: row.actorAddress,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        metadata: row.metadata,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  }
}
