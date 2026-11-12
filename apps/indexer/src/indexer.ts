import { rpc } from "@stellar/stellar-sdk";
import type { ContractName } from "@wpay/config";
import { Prisma, type PrismaClient } from "@wpay/database";
import { decodeEvent, eventPayload, planPaymentUpdate, type RawEvent } from "./decode";

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
  lastLedger: number;
}

/**
 * Ingests Soroban contract events into Postgres.
 *
 * Idempotency: (contractId, txHash, eventIndex) is unique, so replaying a ledger
 * range never double-writes. The checkpoint only advances after the whole batch
 * is committed, which makes a crash re-process at most one batch.
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
    const results: IngestResult[] = [];
    for (const [name, contractId] of Object.entries(this.options.contracts)) {
      if (!contractId) continue;
      results.push(await this.ingestContract(name as ContractName, contractId));
    }
    return results;
  }

  async ingestContract(_name: ContractName, contractId: string): Promise<IngestResult> {
    const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
      where: { contractId },
    });
    const startLedger = Math.max(
      checkpoint?.lastLedger ?? this.options.startLedger,
      this.options.startLedger,
    );

    const response = await this.server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: this.options.batchSize,
    });

    const events = response.events ?? [];
    let inserted = 0;
    let skipped = 0;
    let applied = 0;
    let lastLedger = checkpoint?.lastLedger ?? startLedger;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      // The RPC node gives ids as a paging token; combine it with the batch
      // position so each event is unique even within one ledger.
      const eventIndex = hashToken(event.pagingToken ?? `${event.ledger}:${index}`);
      const raw: RawEvent = {
        contractId,
        ledger: event.ledger,
        txHash: event.txHash,
        topics: event.topic,
        value: event.value,
        pagingToken: event.pagingToken,
      };
      const decoded = decodeEvent(raw);

      try {
        await this.prisma.indexedEvent.create({
          data: {
            contractId,
            ledger: event.ledger,
            txHash: event.txHash,
            eventIndex,
            kind: decoded.kind,
            payload: eventPayload(decoded) as Prisma.InputJsonValue,
          },
        });
        inserted += 1;
        if (await this.applyPayment(decoded)) applied += 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skipped += 1;
          continue;
        }
        throw error;
      }
      lastLedger = Math.max(lastLedger, event.ledger);
    }

    if (events.length > 0) {
      await this.prisma.indexerCheckpoint.upsert({
        where: { contractId },
        create: { contractId, lastLedger },
        update: { lastLedger },
      });
    }

    if (inserted > 0 || skipped > 0) {
      this.log(`${contractId}: fetched=${events.length} inserted=${inserted} skipped=${skipped}`);
    }
    return { fetched: events.length, inserted, skipped, applied, lastLedger };
  }

  /** Applies the payment event to the operational payment row, if it exists. */
  private async applyPayment(event: ReturnType<typeof decodeEvent>): Promise<boolean> {
    const update = planPaymentUpdate(event);
    if (!update) return false;
    const existing = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { contractPaymentId: BigInt(update.contractPaymentId) },
          { txHash: update.txHash },
        ],
      },
    });
    if (!existing) return false;
    if (existing.status === "SETTLED") return false;
    await this.prisma.payment.update({
      where: { id: existing.id },
      data: {
        status: "SETTLED",
        txHash: update.txHash,
        ledger: update.ledger,
        contractPaymentId: BigInt(update.contractPaymentId),
        settledAt: new Date(),
      },
    });
    return true;
  }

  /** Compares indexed totals with the payment ledger for one merchant. */
  async reconcile(merchantId: string): Promise<{ indexedEvents: number; settledPayments: number }> {
    const [indexedEvents, settledPayments] = await Promise.all([
      this.prisma.indexedEvent.count({
        where: { kind: "payment", payload: { path: ["topics"], equals: Prisma.JsonNull } },
      }),
      this.prisma.payment.count({ where: { merchantId, status: "SETTLED" } }),
    ]);
    return { indexedEvents, settledPayments };
  }
}

/** Stable 31-bit-ish integer from a paging token, used as the unique index. */
export function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
