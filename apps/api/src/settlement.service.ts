import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Prisma, serializeBigInts } from "@wpay/database";
import { APP_CONFIG, type AppConfig } from "./config";
import { PrismaService } from "./prisma.service";
import { AuditService } from "./audit.service";
import { SorobanService } from "./soroban.service";
import {
  SettlementExecutionError,
  SorobanSettlementExecutor,
  type SettlementExecutor,
} from "./settlement-executor";
import { requireMerchantAccess, type AuthUser } from "./common";

export type SettlementMode = "off" | "prepare" | "execute";

export interface SettlementSettings {
  mode: SettlementMode;
  holdHours: number;
  maxEntries: number;
  maxSteps: number;
  retryMinutes: number;
  alertMinutes: number;
  operatorAddress?: string;
}

export interface RunSummary {
  mode: SettlementMode;
  skipped?: string;
  releasedPayments: number;
  batchesCreated: number;
  paymentsAssigned: number;
  assignedTotal: string;
  batches: { id: string; token: string; total: string; entries: number }[];
  execution: {
    attempted: number;
    executed: number;
    pending: number;
    failed: number;
    skipped?: string;
  };
  alerts: number;
  errors: string[];
}

interface BatchEntry {
  payee: string;
  amount: bigint;
  merchantId: string | null;
  paymentCount: number;
}

interface PaymentClaim {
  id: string;
  merchantId: string;
  token: string;
  payee: string;
  amount: bigint;
  settledAt: Date;
}

const ELIGIBLE_STATUSES = ["SETTLED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

function settingsFrom(config: AppConfig): SettlementSettings {
  const secret = config.env.SOROBAN_SOURCE_SECRET;
  let operatorAddress = config.env.SETTLEMENT_OPERATOR_ADDRESS;
  if (!operatorAddress && secret) {
    try {
      operatorAddress = Keypair.fromSecret(secret).publicKey();
    } catch {
      throw new Error("SOROBAN_SOURCE_SECRET is not a valid Stellar secret key");
    }
  }
  return {
    mode: config.env.SETTLEMENT_AUTOMATION,
    holdHours: config.env.SETTLEMENT_HOLD_HOURS,
    maxEntries: config.env.SETTLEMENT_MAX_ENTRIES,
    maxSteps: config.env.SETTLEMENT_MAX_STEPS,
    retryMinutes: config.env.SETTLEMENT_RETRY_MINUTES,
    alertMinutes: config.env.SETTLEMENT_DELAY_ALERT_MINUTES,
    operatorAddress,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Claims settled payments into durable settlement batches and drives them
 * through the on-chain window state machine.
 *
 * The safety model is the claim itself: a payment can only be assigned once
 * (`settlementWindowId` is set in the same transaction that creates the batch),
 * and the executor re-reads the contract before every mutation. A lost worker
 * therefore resumes instead of double-paying, and an execution failure leaves
 * an auditable `lastError`/`nextAttemptAt` pair rather than a silent drop.
 */
@Injectable()
export class SettlementAutomationService {
  private readonly logger = new Logger("settlement");
  private readonly settings: SettlementSettings;
  private executor: SettlementExecutor;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.settings = settingsFrom(config);
    this.executor = new SorobanSettlementExecutor(soroban, this.settings.maxSteps);
  }

  /** Replaces the executor in tests; production uses the Soroban executor. */
  setExecutor(executor: SettlementExecutor | null): void {
    this.executor = executor ?? new SorobanSettlementExecutor(this.soroban, this.settings.maxSteps);
  }

  get mode(): SettlementMode {
    return this.settings.mode;
  }

  get operatorAddress(): string | undefined {
    return this.settings.operatorAddress;
  }

  async run(options: { force?: boolean; execute?: boolean; now?: Date } = {}): Promise<RunSummary> {
    const now = options.now ?? new Date();
    const mode = options.execute && this.settings.mode === "execute" ? "execute" : this.settings.mode;
    if (this.settings.mode === "off" && !options.force) {
      return {
        mode,
        skipped: "automation_disabled",
        releasedPayments: 0,
        batchesCreated: 0,
        paymentsAssigned: 0,
        assignedTotal: "0",
        batches: [],
        execution: { attempted: 0, executed: 0, pending: 0, failed: 0 },
        alerts: 0,
        errors: [],
      };
    }
    if (options.execute && this.settings.mode !== "execute") {
      return {
        mode,
        skipped: "execute_not_enabled",
        releasedPayments: 0,
        batchesCreated: 0,
        paymentsAssigned: 0,
        assignedTotal: "0",
        batches: [],
        execution: { attempted: 0, executed: 0, pending: 0, failed: 0 },
        alerts: 0,
        errors: [],
      };
    }

    const releasedPayments = await this.releaseCancelled();
    const prepared = await this.prepare(now);
    const execution =
      mode === "execute"
        ? await this.executeDue(now)
        : { attempted: 0, executed: 0, pending: 0, failed: 0, skipped: "prepare_only" };
    const alerts = await this.alertDelayed(now);

    await this.audit.record(null, "settlement.auto.run", "SettlementWindow", null, {
      mode,
      batchesCreated: prepared.batchesCreated,
      paymentsAssigned: prepared.paymentsAssigned,
      assignedTotal: prepared.assignedTotal.toString(),
      execution,
    });

    return {
      mode,
      releasedPayments,
      batchesCreated: prepared.batchesCreated,
      paymentsAssigned: prepared.paymentsAssigned,
      assignedTotal: prepared.assignedTotal.toString(),
      batches: prepared.batches.map((batch) => ({
        ...batch,
        total: batch.total.toString(),
      })),
      execution,
      alerts,
      errors: prepared.errors,
    };
  }

  /**
   * Releases payments from cancelled batches so they can be batched again.
   * Cancellation means the contract never paid them.
   */
  private async releaseCancelled(): Promise<number> {
    const result = await this.prisma.payment.updateMany({
      where: { settlementWindow: { status: "CANCELLED" } },
      data: { settlementWindowId: null, settlementAmount: null },
    });
    if (result.count > 0) {
      this.logger.log(`released ${result.count} payments from cancelled settlement windows`);
    }
    return result.count;
  }

  private async prepare(now: Date): Promise<{
    batchesCreated: number;
    paymentsAssigned: number;
    assignedTotal: bigint;
    batches: { id: string; token: string; total: bigint; entries: number }[];
    errors: string[];
  }> {
    const cutoff = new Date(now.getTime() - this.settings.holdHours * 3_600_000);
    const rows = await this.prisma.payment.findMany({
      where: {
        status: { in: [...ELIGIBLE_STATUSES] },
        settlementWindowId: null,
        settledAt: { lte: cutoff },
        net: { gt: 0n },
      },
      select: {
        id: true,
        merchantId: true,
        token: true,
        net: true,
        refunded: true,
        settledAt: true,
        merchant: { select: { settlementAddress: true } },
      },
      orderBy: { settledAt: "asc" },
      take: 2_000,
    });

    const claims: PaymentClaim[] = [];
    for (const row of rows) {
      if (!row.settledAt) continue;
      const amount = row.net - row.refunded;
      if (amount <= 0n) continue;
      claims.push({
        id: row.id,
        merchantId: row.merchantId,
        token: row.token,
        payee: row.merchant.settlementAddress,
        amount,
        settledAt: row.settledAt,
      });
    }

    const byToken = new Map<string, PaymentClaim[]>();
    for (const claim of claims) {
      const bucket = byToken.get(claim.token) ?? [];
      bucket.push(claim);
      byToken.set(claim.token, bucket);
    }

    const batches: { id: string; token: string; total: bigint; entries: number }[] = [];
    const errors: string[] = [];
    let paymentsAssigned = 0;
    let assignedTotal = 0n;

    for (const [token, tokenClaims] of byToken) {
      try {
        const batch = await this.createBatchForToken(token, tokenClaims, now);
        if (!batch) continue;
        batches.push({
          id: batch.id,
          token,
          total: batch.total,
          entries: batch.entries,
        });
        paymentsAssigned += batch.paymentCount;
        assignedTotal += batch.total;
        await this.audit.record(null, "settlement.auto.batch", "SettlementWindow", batch.id, {
          token,
          total: batch.total.toString(),
          entries: batch.entries,
          payments: batch.paymentCount,
        });
      } catch (error) {
        const message = `${token}: ${describeError(error)}`;
        errors.push(message);
        this.logger.warn(`automatic settlement batch failed: ${message}`);
      }
    }

    return {
      batchesCreated: batches.length,
      paymentsAssigned,
      assignedTotal,
      batches,
      errors,
    };
  }

  private async createBatchForToken(
    token: string,
    claims: PaymentClaim[],
    now: Date,
  ): Promise<{
    id: string;
    total: bigint;
    entries: number;
    paymentCount: number;
  } | null> {
    const byPayee = new Map<string, PaymentClaim[]>();
    for (const claim of claims) {
      const bucket = byPayee.get(claim.payee) ?? [];
      bucket.push(claim);
      byPayee.set(claim.payee, bucket);
    }
    const payees = [...byPayee.keys()].sort();
    const selectedPayees = payees.slice(0, this.settings.maxEntries);
    const selected = selectedPayees.flatMap((payee) => byPayee.get(payee)!);
    if (selected.length === 0) return null;

    const entries: BatchEntry[] = selectedPayees.map((payee) => {
      const payeeClaims = byPayee.get(payee)!;
      const merchants = new Set(payeeClaims.map((claim) => claim.merchantId));
      return {
        payee,
        amount: payeeClaims.reduce((sum, claim) => sum + claim.amount, 0n),
        merchantId: merchants.size === 1 ? [...merchants][0]! : null,
        paymentCount: payeeClaims.length,
      };
    });
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0n);
    const settledTimes = selected.map((claim) => claim.settledAt.getTime());
    const minSettled = Math.min(...settledTimes);
    const maxSettled = Math.max(...settledTimes);
    let periodStart = new Date(Math.floor(minSettled / 1000) * 1000);
    let periodEnd = new Date(Math.floor((maxSettled + 1000) / 1000) * 1000);
    if (!(periodStart < periodEnd)) periodEnd = new Date(periodStart.getTime() + 1000);

    const batchKey = `auto:${token}:${now.toISOString()}:${randomUUID().slice(0, 8)}`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const window = await tx.settlementWindow.create({
              data: {
                token,
                periodStart,
                periodEnd,
                total,
                auto: true,
                batchKey,
                entries: {
                  create: entries.map((entry) => ({
                    payee: entry.payee,
                    amount: entry.amount,
                    merchantId: entry.merchantId,
                    paymentCount: entry.paymentCount,
                  })),
                },
              },
            });

            let claimed = 0;
            for (const claim of selected) {
              const result = await tx.payment.updateMany({
                where: { id: claim.id, settlementWindowId: null },
                data: { settlementWindowId: window.id, settlementAmount: claim.amount },
              });
              claimed += result.count;
            }
            if (claimed !== selected.length) {
              // Another worker claimed one of these payments; roll back this
              // batch and let the next pass pick the remainder.
              throw new Error("payment claim race: batch was not created");
            }
            return {
              id: window.id,
              total,
              entries: entries.length,
              paymentCount: claimed,
            };
          },
          { timeout: 30_000 },
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // The (token, period) pair is already used. Shift the informational
          // end by one second so batches remain unambiguous for the indexer.
          periodEnd = new Date(periodEnd.getTime() + 1000);
          continue;
        }
        throw error;
      }
    }
    throw new Error("could not allocate a unique settlement period after four attempts");
  }

  private async executeDue(now: Date): Promise<{
    attempted: number;
    executed: number;
    pending: number;
    failed: number;
    skipped?: string;
  }> {
    if (!this.executor.available) {
      return {
        attempted: 0,
        executed: 0,
        pending: 0,
        failed: 0,
        skipped: "operator_signer_not_configured",
      };
    }

    const due = await this.prisma.settlementWindow.findMany({
      where: {
        auto: true,
        status: { in: ["OPEN", "CLOSED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      include: { entries: { orderBy: { payee: "asc" } } },
      orderBy: { createdAt: "asc" },
      take: 5,
    });

    let attempted = 0;
    let executed = 0;
    let pending = 0;
    let failed = 0;

    for (const window of due) {
      const claimed = await this.prisma.settlementWindow.updateMany({
        where: {
          id: window.id,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          lastAttemptAt: now,
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + this.settings.retryMinutes * 60_000),
        },
      });
      if (claimed.count === 0) continue;
      attempted += 1;

      try {
        const result = await this.executor.execute({
          id: window.id,
          token: window.token,
          periodStart: window.periodStart,
          periodEnd: window.periodEnd,
          windowIdOnChain: window.windowIdOnChain,
          entries: window.entries.map((entry) => ({
            payee: entry.payee,
            amount: entry.amount,
          })),
        });
        const executedNow = result.status === "EXECUTED";
        await this.prisma.settlementWindow.update({
          where: { id: window.id },
          data: {
            windowIdOnChain: result.windowIdOnChain,
            status: result.status,
            txHash: result.txHashes.at(-1) ?? window.txHash,
            executedAt: executedNow ? (window.executedAt ?? now) : window.executedAt,
            attempts: 0,
            lastError: null,
            nextAttemptAt: executedNow
              ? null
              : new Date(now.getTime() + this.settings.retryMinutes * 60_000),
            alertedAt: executedNow ? null : window.alertedAt,
          },
        });
        await this.audit.record(null, "settlement.auto.execute", "SettlementWindow", window.id, {
          status: result.status,
          windowIdOnChain: result.windowIdOnChain.toString(),
          txHashes: result.txHashes,
        });
        if (executedNow) executed += 1;
        else pending += 1;
      } catch (error) {
        const attempts = window.attempts + 1;
        const retryable = !(error instanceof SettlementExecutionError) || error.retryable;
        const delayMinutes = Math.min(
          this.settings.retryMinutes * 2 ** Math.min(attempts - 1, 10),
          24 * 60,
        );
        const message = describeError(error);
        await this.prisma.settlementWindow.update({
          where: { id: window.id },
          data: {
            lastError: message.slice(0, 2_000),
            nextAttemptAt: retryable ? new Date(now.getTime() + delayMinutes * 60_000) : null,
            alertedAt: window.alertedAt ?? now,
          },
        });
        await this.audit.record(null, "settlement.auto.failed", "SettlementWindow", window.id, {
          attempts,
          retryable,
          error: message,
        });
        if (!window.alertedAt) {
          await this.notifyBatch(window.id, "Automatic settlement failed", message);
        }
        failed += 1;
        this.logger.warn(`automatic settlement ${window.id} failed: ${message}`);
      }
    }

    return { attempted, executed, pending, failed };
  }

  private async alertDelayed(now: Date): Promise<number> {
    if (!this.executor.available || this.settings.mode !== "execute") return 0;
    const cutoff = new Date(now.getTime() - this.settings.alertMinutes * 60_000);
    const delayed = await this.prisma.settlementWindow.findMany({
      where: {
        auto: true,
        status: { in: ["OPEN", "CLOSED"] },
        createdAt: { lt: cutoff },
        alertedAt: null,
      },
      select: { id: true, token: true, total: true, createdAt: true },
      take: 20,
    });
    for (const window of delayed) {
      await this.prisma.settlementWindow.update({
        where: { id: window.id },
        data: { alertedAt: now },
      });
      await this.notifyBatch(
        window.id,
        "Settlement batch delayed",
        `Batch ${window.id} for token ${window.token} has not executed since ${window.createdAt.toISOString()}.`,
      );
    }
    return delayed.length;
  }

  private async notifyBatch(windowId: string, title: string, body: string): Promise<void> {
    try {
      const window = await this.prisma.settlementWindow.findUnique({
        where: { id: windowId },
        include: { entries: { select: { merchantId: true } } },
      });
      if (!window) return;
      const merchantIds = [
        ...new Set(
          window.entries
            .map((entry) => entry.merchantId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      await this.prisma.notification.create({
        data: {
          channel: "in_app",
          title,
          body: `[${window.token}] ${body}`,
          merchantId: window.merchantId,
        },
      });
      for (const merchantId of merchantIds) {
        await this.prisma.notification.create({
          data: {
            channel: "in_app",
            title,
            body: `[${window.token}] ${body}`,
            merchantId,
          },
        });
      }
    } catch (error) {
      this.logger.warn(`failed to record settlement notification: ${describeError(error)}`);
    }
  }

  /** Clears the backoff on a batch after an operator has investigated it. */
  async retryBatch(user: AuthUser, id: string): Promise<{ retrying: boolean; nextAttemptAt: string }> {
    const window = await this.prisma.settlementWindow.findUnique({ where: { id } });
    if (!window) throw new NotFoundException("settlement batch not found");
    const now = new Date();
    await this.prisma.settlementWindow.update({
      where: { id },
      data: {
        nextAttemptAt: now,
        lastError: window.lastError ? `${window.lastError} (manual retry requested)` : null,
        alertedAt: null,
      },
    });
    await this.audit.record(user, "settlement.auto.retry", "SettlementWindow", id, {
      previousError: window.lastError,
    });
    return { retrying: true, nextAttemptAt: now.toISOString() };
  }

  async automationStatus(limit = 50) {
    const requested = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const rows = await this.prisma.settlementWindow.findMany({
      where: { auto: true },
      include: { entries: { select: { payee: true, amount: true, paymentCount: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(requested, 1), 200),
    });
    return {
      mode: this.settings.mode,
      operatorAddress: this.settings.operatorAddress ?? null,
      executorAvailable: this.executor.available,
      items: serializeBigInts(
        rows.map((row) => ({
          id: row.id,
          token: row.token,
          status: row.status,
          total: row.total,
          periodStart: row.periodStart.toISOString(),
          periodEnd: row.periodEnd.toISOString(),
          windowIdOnChain: row.windowIdOnChain,
          txHash: row.txHash,
          attempts: row.attempts,
          lastError: row.lastError,
          lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
          nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          executedAt: row.executedAt?.toISOString() ?? null,
          entries: row.entries.map((entry) => ({
            payee: entry.payee,
            amount: entry.amount,
            paymentCount: entry.paymentCount,
          })),
        })),
      ),
      nextCursor: null,
    };
  }

  async reconciliation(
    user: AuthUser,
    query: { merchantId?: string; token?: string } = {},
  ) {
    const staff = user.role === "ADMIN" || user.role === "OPERATOR";
    let merchantIds: string[] | null = null;
    if (query.merchantId) {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: query.merchantId } });
      if (!merchant) throw new NotFoundException("merchant not found");
      requireMerchantAccess(user, merchant);
      merchantIds = [merchant.id];
    } else if (!staff) {
      if (user.viaApiKey && user.scopedMerchantId) {
        merchantIds = [user.scopedMerchantId];
      } else {
        const owned = await this.prisma.merchant.findMany({
          where: { ownerUserId: user.id },
          select: { id: true },
          take: 500,
        });
        merchantIds = owned.map((row) => row.id);
      }
      if (merchantIds.length === 0) merchantIds = ["__none__"];
    }

    const filters: Prisma.Sql[] = [
      Prisma.sql`p.status IN ('SETTLED','PARTIALLY_REFUNDED','REFUNDED')`,
    ];
    if (query.token) filters.push(Prisma.sql`p.token = ${query.token}`);
    if (merchantIds) {
      filters.push(Prisma.sql`p."merchantId" IN (${Prisma.join(merchantIds)})`);
    }
    const paymentWhere = Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`;

    const [totals] = await this.prisma.$queryRaw<
      {
        paymentCount: number;
        gross: string;
        fees: string;
        refunded: string;
        payable: string;
        allocated: string;
      }[]
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS "paymentCount",
        COALESCE(SUM(p.amount), 0)::text AS gross,
        COALESCE(SUM(p.fee), 0)::text AS fees,
        COALESCE(SUM(p.refunded), 0)::text AS refunded,
        COALESCE(SUM(GREATEST(p.net - p.refunded, 0)), 0)::text AS payable,
        COALESCE(SUM(COALESCE(p."settlementAmount", 0)), 0)::text AS allocated
      FROM "Payment" p
      ${paymentWhere}
    `);

    const merchants = await this.prisma.$queryRaw<
      {
        merchantId: string;
        name: string;
        settlementAddress: string;
        paymentCount: number;
        gross: string;
        fees: string;
        refunded: string;
        payable: string;
        allocated: string;
      }[]
    >(Prisma.sql`
      SELECT
        p."merchantId" AS "merchantId",
        m.name AS name,
        m."settlementAddress" AS "settlementAddress",
        COUNT(*)::int AS "paymentCount",
        COALESCE(SUM(p.amount), 0)::text AS gross,
        COALESCE(SUM(p.fee), 0)::text AS fees,
        COALESCE(SUM(p.refunded), 0)::text AS refunded,
        COALESCE(SUM(GREATEST(p.net - p.refunded, 0)), 0)::text AS payable,
        COALESCE(SUM(COALESCE(p."settlementAmount", 0)), 0)::text AS allocated
      FROM "Payment" p
      JOIN "Merchant" m ON m.id = p."merchantId"
      ${paymentWhere}
      GROUP BY p."merchantId", m.name, m."settlementAddress"
      ORDER BY m.name ASC
      LIMIT 200
    `);

    const windowFilters: Prisma.Sql[] = [];
    if (merchantIds) {
      windowFilters.push(Prisma.sql`w."merchantId" IN (${Prisma.join(merchantIds)})`);
    }
    if (query.token) windowFilters.push(Prisma.sql`w.token = ${query.token}`);
    const windowWhere =
      windowFilters.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(windowFilters, " AND ")}`
        : Prisma.empty;
    const windowStats = await this.prisma.$queryRaw<
      { status: string; count: number; total: string }[]
    >(Prisma.sql`
      SELECT w.status::text AS status, COUNT(*)::int AS count, COALESCE(SUM(w.total), 0)::text AS total
      FROM "SettlementWindow" w
      ${windowWhere}
      GROUP BY w.status
    `);

    const staleCutoff = new Date(Date.now() - this.settings.alertMinutes * 60_000);
    const baseWindowFilter = merchantIds
      ? { merchantId: { in: merchantIds } }
      : {};
    const [unallocatedPayments, staleWindows, failedWindows] = await Promise.all([
      this.prisma.payment.count({
        where: {
          ...(merchantIds ? { merchantId: { in: merchantIds } } : {}),
          ...(query.token ? { token: query.token } : {}),
          status: { in: [...ELIGIBLE_STATUSES] },
          settlementWindowId: null,
          settledAt: { not: null, lt: new Date(Date.now() - this.settings.holdHours * 3_600_000) },
        },
      }),
      this.prisma.settlementWindow.count({
        where: {
          ...baseWindowFilter,
          ...(query.token ? { token: query.token } : {}),
          status: { in: ["OPEN", "CLOSED"] },
          createdAt: { lt: staleCutoff },
        },
      }),
      this.prisma.settlementWindow.count({
        where: {
          ...baseWindowFilter,
          ...(query.token ? { token: query.token } : {}),
          auto: true,
          status: { in: ["OPEN", "CLOSED"] },
          lastError: { not: null },
        },
      }),
    ]);

    const [settledWithoutTx, paidInvoicesWithoutPayment, executedWithoutTx] = await Promise.all([
      this.prisma.payment.count({
        where: {
          ...(merchantIds ? { merchantId: { in: merchantIds } } : {}),
          ...(query.token ? { token: query.token } : {}),
          status: { in: [...ELIGIBLE_STATUSES] },
          OR: [{ txHash: null }, { contractPaymentId: null }],
        },
      }),
      this.prisma.invoice.count({
        where: {
          ...(merchantIds ? { merchantId: { in: merchantIds } } : {}),
          ...(query.token ? { token: query.token } : {}),
          status: "PAID",
          paymentId: null,
        },
      }),
      this.prisma.settlementWindow.count({
        where: {
          ...baseWindowFilter,
          ...(query.token ? { token: query.token } : {}),
          status: "EXECUTED",
          txHash: null,
        },
      }),
    ]);

    const mismatches = await this.prisma.$queryRaw<
      { id: string; total: string; entryTotal: string }[]
    >(Prisma.sql`
      SELECT w.id, w.total::text AS total, COALESCE(SUM(e.amount), 0)::text AS "entryTotal"
      FROM "SettlementWindow" w
      LEFT JOIN "SettlementEntry" e ON e."settlementWindowId" = w.id
      ${windowWhere}
      GROUP BY w.id, w.total
      HAVING w.total <> COALESCE(SUM(e.amount), 0)
      LIMIT 20
    `);

    const payable = BigInt(totals?.payable ?? "0");
    const allocated = BigInt(totals?.allocated ?? "0");
    return {
      generatedAt: new Date().toISOString(),
      filters: { merchantId: query.merchantId ?? null, token: query.token ?? null },
      settings: {
        mode: this.settings.mode,
        holdHours: this.settings.holdHours,
        maxEntries: this.settings.maxEntries,
        retryMinutes: this.settings.retryMinutes,
        alertMinutes: this.settings.alertMinutes,
        executorAvailable: this.executor.available,
      },
      payments: {
        count: totals?.paymentCount ?? 0,
        gross: totals?.gross ?? "0",
        fees: totals?.fees ?? "0",
        refunded: totals?.refunded ?? "0",
        payable: totals?.payable ?? "0",
        allocated: totals?.allocated ?? "0",
        unallocated: (payable > allocated ? payable - allocated : 0n).toString(),
      },
      merchants,
      windows: {
        byStatus: Object.fromEntries(windowStats.map((row) => [row.status, row])),
        stale: staleWindows,
        failed: failedWindows,
      },
      treasury: {
        feeRevenue: totals?.fees ?? "0",
        grossVolume: totals?.gross ?? "0",
        refundedVolume: totals?.refunded ?? "0",
      },
      invariants: {
        settledWithoutTx,
        paidInvoicesWithoutPayment,
        executedWithoutTx,
        unallocatedPayments,
        windowTotalMismatch: mismatches,
      },
    };
  }
}
