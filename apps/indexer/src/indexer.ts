import { rpc } from "@stellar/stellar-sdk";
import type { ContractName } from "@wpay/config";
import { Prisma, type PrismaClient } from "@wpay/database";
import {
  decodeEvent,
  eventPayload,
  planEvent,
  type Projection,
  type RawEvent,
} from "./decode";

export interface IndexerOptions {
  rpcUrl: string;
  contracts: Partial<Record<ContractName, string>>;
  startLedger: number;
  batchSize: number;
  logger?: (message: string) => void;
}

export interface IngestResult {
  fetched: number;
  inserted: number;
  skipped: number;
  applied: number;
  failed: number;
  lastLedger: number;
}

export interface RetryResult {
  retried: number;
  resolved: number;
  stillFailing: number;
}

export interface ReconcileResult {
  indexedEvents: number;
  settledPayments: number;
  linkedPayments: number;
  pendingPayments: number;
}

/**
 * Ingests Soroban contract events into Postgres.
 *
 * Each event is persisted and projected inside one transaction, so a crash can
 * never leave an event recorded without its domain update (or vice versa).
 * Idempotency comes from the unique (contractId, txHash, eventIndex) index: a
 * replay aborts that transaction and is counted as skipped.
 */
export class Indexer {
  private readonly server: rpc.Server;
  private readonly log: (message: string) => void;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: IndexerOptions,
  ) {
    this.server = new rpc.Server(options.rpcUrl, {
      allowHttp: options.rpcUrl.startsWith("http://"),
    });
    this.log = options.logger ?? ((message) => console.log(`[indexer] ${message}`));
  }

  async runOnce(): Promise<IngestResult[]> {
    const retry = await this.retryFailures();
    if (retry.retried > 0) {
      this.log(
        `retried=${retry.retried} resolved=${retry.resolved} still_failing=${retry.stillFailing}`,
      );
    }
    const results: IngestResult[] = [];
    for (const [name, contractId] of Object.entries(this.options.contracts)) {
      if (!contractId) continue;
      results.push(await this.ingestContract(name as ContractName, contractId));
    }
    return results;
  }

  /**
   * Re-applies projections that previously could not be matched. This is safe
   * because projections only mutate rows they can identify unambiguously; a
   * second success is impossible once the row is linked.
   */
  async retryFailures(limit = 50): Promise<RetryResult> {
    const rows = await this.prisma.indexerFailure.findMany({
      where: { resolvedAt: null, projection: { not: Prisma.DbNull } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let resolved = 0;
    for (const row of rows) {
      const projection = row.projection as unknown as Projection;
      try {
        const applied = await this.prisma.$transaction((tx) => applyProjection(tx, projection));
        if (applied) {
          await this.prisma.indexerFailure.update({
            where: { id: row.id },
            data: { resolvedAt: new Date(), attempts: { increment: 1 }, reason: "resolved on retry" },
          });
          resolved += 1;
        } else {
          await this.prisma.indexerFailure.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 } },
          });
        }
      } catch (error) {
        await this.prisma.indexerFailure.update({
          where: { id: row.id },
          data: {
            attempts: { increment: 1 },
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return { retried: rows.length, resolved, stillFailing: rows.length - resolved };
  }

  async ingestContract(name: ContractName, contractId: string): Promise<IngestResult> {
    const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
      where: { contractId },
    });
    const startLedger = Math.max(
      checkpoint?.lastLedger ?? this.options.startLedger,
      this.options.startLedger,
    );
    const filters = [{ type: "contract" as const, contractIds: [contractId] }];

    // Cursor mode can resume in the middle of a ledger. If the RPC provider has
    // already pruned that cursor, fall back to the last fully processed ledger;
    // duplicate records are skipped by the unique event index.
    let response: rpc.Api.GetEventsResponse;
    let usedCursor = Boolean(checkpoint?.cursor);
    if (checkpoint?.cursor) {
      try {
        response = await this.server.getEvents({
          cursor: checkpoint.cursor,
          filters,
          limit: this.options.batchSize,
        });
      } catch (error) {
        this.log(
          `${contractId}: cursor ${checkpoint.cursor} rejected (${describeError(error)}); resuming from ledger ${startLedger}`,
        );
        usedCursor = false;
        response = await this.fetchFromLedger(startLedger, filters);
      }
    } else {
      response = await this.fetchFromLedger(startLedger, filters);
    }

    const events = response.events ?? [];
    let inserted = 0;
    let skipped = 0;
    let applied = 0;
    let failed = 0;
    let lastLedger = checkpoint?.lastLedger ?? startLedger;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const eventIndex = event.id ?? `${event.txHash}:${index}`;
      const raw: RawEvent = {
        contractId,
        ledger: event.ledger,
        txHash: event.txHash,
        topics: event.topic,
        value: event.value,
        pagingToken: event.id,
      };
      const decoded = decodeEvent(raw);
      const malformed = decoded.kind === "unknown" || decoded.data === null;
      let projection: Projection | null = null;
      let planError: string | null = null;
      if (!malformed) {
        try {
          projection = planEvent(name, decoded);
        } catch (cause) {
          planError = cause instanceof Error ? cause.message : String(cause);
        }
      }

      try {
        const didApply = await this.prisma.$transaction(async (tx) => {
          await tx.indexedEvent.create({
            data: {
              contractId,
              ledger: event.ledger,
              txHash: event.txHash,
              eventIndex,
              kind: decoded.kind,
              payload: eventPayload(decoded) as Prisma.InputJsonValue,
            },
          });
          if (malformed || planError) {
            await tx.indexerFailure.create({
              data: {
                contractId,
                eventIndex,
                txHash: event.txHash,
                ledger: event.ledger,
                kind: decoded.kind,
                reason: malformed ? "event could not be decoded" : `projection planning failed: ${planError}`,
              },
            });
            return false;
          }
          if (!projection) return false;
          const didApply = await applyProjection(tx, projection);
          if (!didApply) {
            await tx.indexerFailure.create({
              data: {
                contractId,
                eventIndex,
                txHash: event.txHash,
                ledger: event.ledger,
                kind: decoded.kind,
                reason: "projection could not match a unique local record",
                projection: projection as unknown as Prisma.InputJsonValue,
              },
            });
          }
          return didApply;
        });
        inserted += 1;
        if (didApply) {
          applied += 1;
          await this.prisma.indexerFailure.updateMany({
            where: { contractId, eventIndex, resolvedAt: null },
            data: { resolvedAt: new Date(), reason: "resolved by later application" },
          });
        } else if (malformed || planError || projection) {
          failed += 1;
        }
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skipped += 1;
          continue;
        }
        throw error;
      }
      lastLedger = Math.max(lastLedger, event.ledger);
    }

    // A partial page means the node reached the tip of the event stream and we
    // can checkpoint past empty ranges. A full page keeps the last processed
    // ledger, because more events may follow in the same ledger.
    const latestLedger =
      events.length < this.options.batchSize && typeof response.latestLedger === "number"
        ? response.latestLedger
        : lastLedger;
    lastLedger = Math.max(lastLedger, latestLedger);

    const nextCursor =
      typeof response.cursor === "string" && response.cursor.length > 0
        ? response.cursor
        : checkpoint?.cursor ?? null;
    const checkpointBefore = checkpoint?.lastLedger ?? this.options.startLedger;
    if (
      events.length > 0 ||
      lastLedger > checkpointBefore ||
      nextCursor !== (checkpoint?.cursor ?? null)
    ) {
      await this.prisma.indexerCheckpoint.upsert({
        where: { contractId },
        create: { contractId, lastLedger, cursor: nextCursor },
        update: { lastLedger, cursor: nextCursor },
      });
    }

    if (inserted > 0 || skipped > 0) {
      this.log(
        `${contractId}: fetched=${events.length} inserted=${inserted} skipped=${skipped} applied=${applied} mode=${usedCursor ? "cursor" : "ledger"}`,
      );
    }
    return { fetched: events.length, inserted, skipped, applied, failed, lastLedger };
  }

  /**
   * Fetches from a ledger, clamping to the RPC provider's retention window.
   * A brand-new deployment that starts at ledger 1 (or long after a cursor
   * expired) would otherwise fail forever: Soroban RPC only retains a recent
   * range, and events older than it are already pruned. Starting at the oldest
   * retained ledger keeps the indexer making progress instead of erroring.
   */
  private async fetchFromLedger(
    startLedger: number,
    filters: rpc.Api.EventFilter[],
  ): Promise<rpc.Api.GetEventsResponse> {
    try {
      return await this.server.getEvents({ startLedger, filters, limit: this.options.batchSize });
    } catch (error) {
      const range = retainedLedgerRange(describeError(error));
      if (!range || range.oldest <= startLedger) throw error;
      this.log(
        `startLedger ${startLedger} is outside the retained range ${range.oldest}-${range.latest}; resuming from ${range.oldest}`,
      );
      return await this.server.getEvents({
        startLedger: range.oldest,
        filters,
        limit: this.options.batchSize,
      });
    }
  }

  /** Compares indexed totals with the operational ledger for one merchant. */
  async reconcile(merchantId: string): Promise<ReconcileResult> {
    const [indexedEvents, settledPayments, linkedPayments, pendingPayments] = await Promise.all([
      this.prisma.indexedEvent.count({ where: { kind: "payment" } }),
      this.prisma.payment.count({ where: { merchantId, status: "SETTLED" } }),
      this.prisma.payment.count({
        where: { merchantId, contractPaymentId: { not: null } },
      }),
      this.prisma.payment.count({ where: { merchantId, status: "PENDING" } }),
    ]);
    return { indexedEvents, settledPayments, linkedPayments, pendingPayments };
  }
}

function single<T>(rows: T[]): T | null {
  return rows.length === 1 ? rows[0]! : null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Parses Soroban RPC's "startLedger must be within the ledger range: A - B". */
export function retainedLedgerRange(message: string): { oldest: number; latest: number } | null {
  const match = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(message);
  if (!match) return null;
  const oldest = Number(match[1]);
  const latest = Number(match[2]);
  if (!Number.isFinite(oldest) || !Number.isFinite(latest)) return null;
  return { oldest, latest };
}

async function applyPaymentSettled(
  tx: Prisma.TransactionClient,
  p: Extract<Projection, { type: "payment.settled" }>,
): Promise<boolean> {
  if (!p.amount) return false;
  const amount = BigInt(p.amount);
  const contractPaymentId = BigInt(p.contractPaymentId);
  const merchant = p.contractMerchantId
    ? await tx.merchant.findFirst({ where: { registryId: BigInt(p.contractMerchantId) } })
    : null;

  let payment = await tx.payment.findFirst({
    where: { OR: [{ contractPaymentId }, { txHash: p.txHash }] },
  });

  if (!payment) {
    const candidates = await tx.payment.findMany({
      where: {
        status: "PENDING",
        txHash: null,
        amount,
        ...(p.payer ? { payerAddress: p.payer } : {}),
        ...(merchant ? { merchantId: merchant.id } : {}),
      },
      take: 2,
      orderBy: { createdAt: "asc" },
    });
    payment = single(candidates);
  }
  if (!payment) return false;
  if (payment.amount !== amount) return false;
  if (p.payer && payment.payerAddress !== p.payer) return false;

  // A settled payment must never be re-pointed at a different transaction.
  if (payment.status === "SETTLED") return false;

  const alreadyLinked = await tx.payment.findUnique({ where: { contractPaymentId } });
  if (alreadyLinked && alreadyLinked.id !== payment.id) return false;

  const fee = p.fee ? BigInt(p.fee) : payment.fee;
  payment = await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: "SETTLED",
      txHash: p.txHash,
      ledger: p.ledger,
      contractPaymentId,
      contractMerchantId: p.contractMerchantId
        ? BigInt(p.contractMerchantId)
        : payment.contractMerchantId,
      fee,
      net: amount - fee,
      settledAt: payment.settledAt ?? new Date(),
    },
  });

  if (payment.memo) {
    await tx.invoice.updateMany({
      where: { number: payment.memo, paymentId: null },
      data: {
        status: "PAID",
        paidAt: new Date(),
        paymentId: payment.id,
        contractPaymentId,
        txHash: p.txHash,
      },
    });
  }
  await tx.invoice.updateMany({
    where: { contractPaymentId, paymentId: null },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentId: payment.id,
      txHash: p.txHash,
    },
  });
  return true;
}

export async function applyProjection(
  tx: Prisma.TransactionClient,
  projection: Projection,
): Promise<boolean> {
  switch (projection.type) {
    case "payment.settled":
      return applyPaymentSettled(tx, projection);

    case "payment.refunded": {
      const payment = await tx.payment.findUnique({
        where: { contractPaymentId: BigInt(projection.contractPaymentId) },
      });
      if (!payment) return false;
      const refunded = BigInt(projection.refunded);
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refunded,
          status: refunded >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      });
      return true;
    }

    case "refund.requested": {
      const payment = await tx.payment.findUnique({
        where: { contractPaymentId: BigInt(projection.contractPaymentId) },
      });
      if (!payment) return false;
      const refund = single(
        await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: "PENDING",
            contractRefundId: null,
            ...(projection.amount ? { amount: BigInt(projection.amount) } : {}),
          },
          take: 2,
          orderBy: { createdAt: "asc" },
        }),
      );
      if (!refund) return false;
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          contractRefundId: BigInt(projection.contractRefundId),
          txHash: projection.txHash,
        },
      });
      return true;
    }

    case "refund.approved":
    case "refund.rejected": {
      const result = await tx.refund.updateMany({
        where: { contractRefundId: BigInt(projection.contractRefundId) },
        data: {
          status: projection.type === "refund.approved" ? "APPROVED" : "REJECTED",
          txHash: projection.txHash,
          decidedAt: new Date(),
        },
      });
      return result.count > 0;
    }

    case "escrow.created": {
      if (!projection.payer || !projection.payee || !projection.amount) return false;
      const escrow = single(
        await tx.escrow.findMany({
          where: {
            payerAddress: projection.payer,
            payeeAddress: projection.payee,
            amount: BigInt(projection.amount),
            status: "CREATED",
            contractEscrowId: null,
          },
          take: 2,
          orderBy: { createdAt: "asc" },
        }),
      );
      if (!escrow) return false;
      await tx.escrow.update({
        where: { id: escrow.id },
        data: {
          contractEscrowId: BigInt(projection.contractEscrowId),
          txHash: projection.txHash,
          status: "FUNDED",
        },
      });
      return true;
    }

    case "escrow.status": {
      const result = await tx.escrow.updateMany({
        where: { contractEscrowId: BigInt(projection.contractEscrowId) },
        data: { status: projection.status, txHash: projection.txHash },
      });
      return result.count > 0;
    }

    case "invoice.created": {
      if (!projection.contractMerchantId || !projection.amount) return false;
      const merchant = await tx.merchant.findFirst({
        where: { registryId: BigInt(projection.contractMerchantId) },
      });
      if (!merchant) return false;
      const invoice = single(
        await tx.invoice.findMany({
          where: {
            merchantId: merchant.id,
            amount: BigInt(projection.amount),
            status: "OPEN",
            contractInvoiceId: null,
          },
          take: 2,
          orderBy: { createdAt: "asc" },
        }),
      );
      if (!invoice) return false;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          contractInvoiceId: BigInt(projection.contractInvoiceId),
          txHash: projection.txHash,
        },
      });
      return true;
    }

    case "invoice.paid": {
      const contractInvoiceId = BigInt(projection.contractInvoiceId);
      const invoice = await tx.invoice.findUnique({ where: { contractInvoiceId } });
      if (!invoice) return false;
      let paymentId = invoice.paymentId;
      if (projection.contractPaymentId) {
        const payment = await tx.payment.findUnique({
          where: { contractPaymentId: BigInt(projection.contractPaymentId) },
        });
        if (payment) paymentId = payment.id;
      }
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: "PAID",
          paidAt: invoice.paidAt ?? new Date(),
          paymentId,
          txHash: projection.txHash,
          contractPaymentId: projection.contractPaymentId
            ? BigInt(projection.contractPaymentId)
            : invoice.contractPaymentId,
        },
      });
      return true;
    }

    case "invoice.status": {
      const result = await tx.invoice.updateMany({
        where: { contractInvoiceId: BigInt(projection.contractInvoiceId) },
        data: { status: projection.status, txHash: projection.txHash },
      });
      return result.count > 0;
    }

    case "plan.created": {
      if (!projection.contractMerchantId || !projection.amount) return false;
      const merchant = await tx.merchant.findFirst({
        where: { registryId: BigInt(projection.contractMerchantId) },
      });
      if (!merchant) return false;
      const plan = single(
        await tx.subscriptionPlan.findMany({
          where: {
            merchantId: merchant.id,
            amount: BigInt(projection.amount),
            planIdOnChain: null,
          },
          take: 2,
          orderBy: { createdAt: "asc" },
        }),
      );
      if (!plan) return false;
      await tx.subscriptionPlan.update({
        where: { id: plan.id },
        data: { planIdOnChain: BigInt(projection.planIdOnChain) },
      });
      return true;
    }

    case "plan.active": {
      const result = await tx.subscriptionPlan.updateMany({
        where: { planIdOnChain: BigInt(projection.planIdOnChain) },
        data: { active: projection.active },
      });
      return result.count > 0;
    }

    case "subscription.created": {
      const plan = await tx.subscriptionPlan.findUnique({
        where: { planIdOnChain: BigInt(projection.planIdOnChain) },
      });
      if (!plan || !projection.subscriber) return false;
      const subscription = await tx.subscription.findUnique({
        where: { planId_subscriber: { planId: plan.id, subscriber: projection.subscriber } },
      });
      if (!subscription) return false;
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          contractSubId: BigInt(projection.contractSubId),
          txHash: projection.txHash,
          status: "ACTIVE",
          nextDueAt: new Date(Date.now() + plan.intervalSecs * 1000),
        },
      });
      return true;
    }

    case "subscription.charged": {
      const contractSubId = BigInt(projection.contractSubId);
      const subscription = await tx.subscription.findUnique({
        where: { contractSubId },
      });
      if (!subscription) return false;
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: subscription.planId },
      });
      const prepaid = subscription.prepaid - BigInt(projection.amount);
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          cyclesCharged: subscription.cyclesCharged + Number(projection.cyclesCharged),
          prepaid: prepaid > 0n ? prepaid : 0n,
          nextDueAt: new Date(
            subscription.nextDueAt.getTime() + (plan?.intervalSecs ?? 0) * 1000,
          ),
          txHash: projection.txHash,
        },
      });
      return true;
    }

    case "subscription.cancelled": {
      const result = await tx.subscription.updateMany({
        where: { contractSubId: BigInt(projection.contractSubId) },
        data: { status: "CANCELLED", prepaid: 0n, txHash: projection.txHash },
      });
      return result.count > 0;
    }

    case "settlement.opened": {
      if (!projection.token || projection.periodStart === undefined || projection.periodEnd === undefined) {
        return false;
      }
      const onChainId = BigInt(projection.windowIdOnChain);
      const linked = await tx.settlementWindow.findUnique({ where: { windowIdOnChain: onChainId } });
      if (linked) {
        return (
          linked.token === projection.token &&
          linked.periodStart.getTime() === projection.periodStart * 1000 &&
          linked.periodEnd.getTime() === projection.periodEnd * 1000
        );
      }
      const window = single(
        await tx.settlementWindow.findMany({
          where: {
            token: projection.token,
            periodStart: new Date(projection.periodStart * 1000),
            periodEnd: new Date(projection.periodEnd * 1000),
            windowIdOnChain: null,
          },
          take: 2,
          orderBy: { createdAt: "asc" },
        }),
      );
      if (!window) return false;
      await tx.settlementWindow.update({
        where: { id: window.id },
        data: {
          windowIdOnChain: onChainId,
          txHash: projection.txHash,
        },
      });
      return true;
    }

    case "settlement.closed": {
      const result = await tx.settlementWindow.updateMany({
        where: { windowIdOnChain: BigInt(projection.windowIdOnChain) },
        data: { status: "CLOSED", total: BigInt(projection.total), txHash: projection.txHash },
      });
      return result.count > 0;
    }

    case "settlement.executed": {
      const result = await tx.settlementWindow.updateMany({
        where: { windowIdOnChain: BigInt(projection.windowIdOnChain) },
        data: {
          status: "EXECUTED",
          total: BigInt(projection.total),
          executedAt: new Date(),
          txHash: projection.txHash,
        },
      });
      return result.count > 0;
    }

    case "settlement.cancelled": {
      const result = await tx.settlementWindow.updateMany({
        where: { windowIdOnChain: BigInt(projection.windowIdOnChain) },
        data: { status: "CANCELLED", txHash: projection.txHash },
      });
      return result.count > 0;
    }

    case "merchant.registered": {
      const result = await tx.merchant.updateMany({
        where: { ownerAddress: projection.owner, registryId: null },
        data: { registryId: BigInt(projection.registryId) },
      });
      return result.count > 0;
    }

    case "merchant.status": {
      const result = await tx.merchant.updateMany({
        where: { registryId: BigInt(projection.registryId) },
        data: { status: projection.status },
      });
      return result.count > 0;
    }

    case "merchant.settlement": {
      const result = await tx.merchant.updateMany({
        where: { registryId: BigInt(projection.registryId) },
        data: { settlementAddress: projection.settlement },
      });
      return result.count > 0;
    }
  }
}

/** Stable 31-bit-ish integer from a paging token, retained for compatibility. */
export function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
