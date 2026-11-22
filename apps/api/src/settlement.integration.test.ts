/**
 * Settlement automation against a real PostgreSQL database.
 *
 * The Soroban executor is replaced with a deterministic fake, while every
 * persistence path (payment claims, batch creation, backoff, notifications and
 * reconciliation SQL) runs for real. Skipped when DATABASE_URL is absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PrismaClient } from "@wpay/database";
import { loadConfig } from "./config";
import { PrismaService } from "./prisma.service";
import { AuditService } from "./audit.service";
import { SorobanService } from "./soroban.service";
import {
  SettlementAutomationService,
  type RunSummary,
} from "./settlement.service";
import {
  SettlementExecutionError,
  type SettlementExecutionResult,
  type SettlementExecutionWindow,
  type SettlementExecutor,
} from "./settlement-executor";
import type { AuthUser } from "./common";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const run = `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function address(): string {
  return Keypair.random().publicKey();
}

class FakeExecutor implements SettlementExecutor {
  available = true;
  calls: SettlementExecutionWindow[] = [];
  handler: (window: SettlementExecutionWindow) => Promise<SettlementExecutionResult> = async (
    _window,
  ) => {
    throw new Error("handler not configured");
  };

  async execute(window: SettlementExecutionWindow): Promise<SettlementExecutionResult> {
    this.calls.push(window);
    return this.handler(window);
  }
}

let nextWindowId = 1_000n;
let lastExecutedWindowId = 0n;

function executed(window: SettlementExecutionWindow): SettlementExecutionResult {
  const windowIdOnChain = window.windowIdOnChain ?? nextWindowId++;
  lastExecutedWindowId = windowIdOnChain;
  return {
    windowIdOnChain,
    status: "EXECUTED",
    txHashes: ["a".repeat(64)],
    entriesOnChain: window.entries.length,
  };
}

describe.skipIf(!hasDatabase)("settlement automation against PostgreSQL", () => {
  let prisma: PrismaClient;
  let service: SettlementAutomationService;
  let executor: FakeExecutor;
  let merchantA: { id: string; settlementAddress: string };
  let merchantB: { id: string; settlementAddress: string };
  let merchantC: { id: string; settlementAddress: string };
  const windowIds = new Set<string>();
  const admin: AuthUser = {
    id: `admin-${run}`,
    email: `admin.${run}@wpay.test`,
    role: "ADMIN",
    stellarAddress: null,
    scopedMerchantId: null,
    viaApiKey: false,
  };

  const token = () => address();
  const old = () => new Date(Date.now() - 48 * 3_600_000);
  const recent = () => new Date(Date.now() - 60_000);

  function track<T extends { id: string }>(row: T): T {
    windowIds.add(row.id);
    return row;
  }

  async function createPayment(input: {
    merchantId: string;
    token: string;
    amount: bigint;
    net: bigint;
    refunded?: bigint;
    status?: "SETTLED" | "PARTIALLY_REFUNDED" | "REFUNDED";
    settledAt?: Date;
  }): Promise<{ id: string }> {
    return prisma.payment.create({
      data: {
        merchantId: input.merchantId,
        payerAddress: address(),
        token: input.token,
        amount: input.amount,
        fee: input.amount - input.net,
        net: input.net,
        refunded: input.refunded ?? 0n,
        status: input.status ?? "SETTLED",
        settledAt: input.settledAt ?? old(),
      },
      select: { id: true },
    });
  }

  async function createMerchant(label: string): Promise<{ id: string; settlementAddress: string }> {
    return prisma.merchant.create({
      data: {
        ownerAddress: address(),
        settlementAddress: address(),
        name: `${label} ${run}`,
        status: "ACTIVE",
      },
      select: { id: true, settlementAddress: true },
    });
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_SECRET: "dev-secret-that-is-at-least-32-characters-long",
      STELLAR_NETWORK: "testnet",
      SETTLEMENT_AUTOMATION: "execute",
      SETTLEMENT_HOLD_HOURS: "24",
      SETTLEMENT_MAX_ENTRIES: "2",
      SETTLEMENT_RETRY_MINUTES: "30",
      SETTLEMENT_DELAY_ALERT_MINUTES: "120",
      SOROBAN_SOURCE_SECRET: Keypair.random().secret(),
    });
    prisma = new PrismaService();
    await prisma.$connect();
    const soroban = new SorobanService(config);
    const audit = new AuditService(prisma);
    service = new SettlementAutomationService(prisma, soroban, audit, config);
    executor = new FakeExecutor();
    executor.handler = async (window) => executed(window);
    service.setExecutor(executor);

    merchantA = await createMerchant("Merchant A");
    merchantB = await createMerchant("Merchant B");
    merchantC = await createMerchant("Merchant C");
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = [...windowIds];
    await prisma.notification.deleteMany({
      where: { merchantId: { in: [merchantA?.id, merchantB?.id, merchantC?.id].filter(Boolean) } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entity: "SettlementWindow",
        OR: [{ entityId: { in: ids } }, { entityId: null }],
        action: { startsWith: "settlement.auto." },
      },
    });
    await prisma.payment.deleteMany({
      where: { merchantId: { in: [merchantA?.id, merchantB?.id, merchantC?.id].filter(Boolean) } },
    });
    await prisma.settlementWindow.deleteMany({ where: { id: { in: ids } } });
    await prisma.merchant.deleteMany({
      where: { id: { in: [merchantA?.id, merchantB?.id, merchantC?.id].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it("claims eligible payments once, aggregates refunds and respects the hold period", async () => {
    const paidToken = token();
    const first = await createPayment({
      merchantId: merchantA.id,
      token: paidToken,
      amount: 1_000n,
      net: 900n,
    });
    const refunded = await createPayment({
      merchantId: merchantA.id,
      token: paidToken,
      amount: 1_000n,
      net: 900n,
      refunded: 300n,
      status: "PARTIALLY_REFUNDED",
    });
    const second = await createPayment({
      merchantId: merchantB.id,
      token: paidToken,
      amount: 500n,
      net: 450n,
    });
    const held = await createPayment({
      merchantId: merchantA.id,
      token: paidToken,
      amount: 2_000n,
      net: 1_800n,
      settledAt: recent(),
    });

    const summary = await service.run({ force: true });
    expect(summary.batchesCreated).toBe(1);
    expect(summary.paymentsAssigned).toBe(3);
    expect(summary.assignedTotal).toBe("1950");
    const batch = summary.batches[0]!;
    windowIds.add(batch.id);
    expect(batch.entries).toBe(2);
    expect(batch.total).toBe("1950");

    const rows = await prisma.payment.findMany({
      where: { id: { in: [first.id, refunded.id, second.id, held.id] } },
      select: { id: true, settlementWindowId: true, settlementAmount: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.id)?.settlementWindowId).toBe(batch.id);
    expect(byId.get(first.id)?.settlementAmount).toBe(900n);
    expect(byId.get(refunded.id)?.settlementAmount).toBe(600n);
    expect(byId.get(second.id)?.settlementAmount).toBe(450n);
    expect(byId.get(held.id)?.settlementWindowId).toBeNull();

    const entries = await prisma.settlementEntry.findMany({
      where: { settlementWindowId: batch.id },
      orderBy: { payee: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.amount).sort((a, b) => (a < b ? -1 : 1))).toEqual([
      450n,
      1500n,
    ]);
    expect(entries.find((entry) => entry.payee === merchantA.settlementAddress)?.paymentCount).toBe(2);

    // A second pass must not claim the same payments again.
    const rerun = await service.run({ force: true });
    expect(rerun.batchesCreated).toBe(0);
    expect(rerun.paymentsAssigned).toBe(0);
  });

  it("executes a prepared batch and records the on-chain window id", async () => {
    const settlementToken = token();
    await createPayment({
      merchantId: merchantC.id,
      token: settlementToken,
      amount: 200n,
      net: 180n,
    });
    const summary = await service.run({ force: true });
    expect(summary.batchesCreated).toBe(1);
    expect(summary.execution.executed).toBe(1);
    const id = summary.batches[0]!.id;
    windowIds.add(id);
    const window = await prisma.settlementWindow.findUniqueOrThrow({ where: { id } });
    expect(window.status).toBe("EXECUTED");
    expect(window.windowIdOnChain).toBe(lastExecutedWindowId);
    expect(window.lastError).toBeNull();
    expect(window.attempts).toBe(0);
    expect(window.txHash).toBe("a".repeat(64));

    const audit = await prisma.auditLog.count({
      where: { action: "settlement.auto.execute", entityId: id },
    });
    expect(audit).toBe(1);
  });

  it("backs off, alerts, and retries a failed batch", async () => {
    const failureToken = token();
    await createPayment({
      merchantId: merchantB.id,
      token: failureToken,
      amount: 400n,
      net: 360n,
    });
    executor.handler = async () => {
      throw new SettlementExecutionError("rpc unavailable", true);
    };
    const failedRun = await service.run({ force: true });
    expect(failedRun.batchesCreated).toBe(1);
    expect(failedRun.execution.failed).toBe(1);
    const id = failedRun.batches[0]!.id;
    windowIds.add(id);
    const failed = await prisma.settlementWindow.findUniqueOrThrow({ where: { id } });
    expect(failed.status).toBe("OPEN");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain("rpc unavailable");
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(failed.alertedAt).not.toBeNull();

    const notifications = await prisma.notification.count({
      where: { merchantId: merchantB.id, title: "Automatic settlement failed" },
    });
    expect(notifications).toBe(1);

    executor.handler = async (window) => executed(window);
    const retryAt = new Date((failed.nextAttemptAt ?? new Date()).getTime() + 1_000);
    const retried = await service.run({ force: true, now: retryAt });
    expect(retried.execution.executed).toBe(1);
    const recovered = await prisma.settlementWindow.findUniqueOrThrow({ where: { id } });
    expect(recovered.status).toBe("EXECUTED");
    expect(recovered.lastError).toBeNull();
    expect(recovered.attempts).toBe(0);
  });

  it("does not schedule automatic retries for non-retryable failures", async () => {
    const terminalToken = token();
    await createPayment({
      merchantId: merchantA.id,
      token: terminalToken,
      amount: 120n,
      net: 100n,
    });
    executor.handler = async () => {
      throw new SettlementExecutionError("on-chain window has different entries", false);
    };
    const summary = await service.run({ force: true });
    expect(summary.execution.failed).toBe(1);
    const window = await prisma.settlementWindow.findUniqueOrThrow({
      where: { id: summary.batches[0]!.id },
    });
    windowIds.add(window.id);
    expect(window.nextAttemptAt).toBeNull();
    expect(window.lastError).toContain("different entries");
  });

  it("releases payments from cancelled batches so they can settle again", async () => {
    const cancelledToken = token();
    const payment = await createPayment({
      merchantId: merchantC.id,
      token: cancelledToken,
      amount: 90n,
      net: 80n,
    });
    const cancelled = track(
      await prisma.settlementWindow.create({
        data: {
          token: cancelledToken,
          periodStart: old(),
          periodEnd: new Date(old().getTime() + 1_000),
          status: "CANCELLED",
          total: 80n,
          auto: true,
        },
      }),
    );
    await prisma.payment.update({
      where: { id: payment.id },
      data: { settlementWindowId: cancelled.id, settlementAmount: 80n },
    });

    executor.handler = async (window) => executed(window);
    const summary = await service.run({ force: true });
    expect(summary.releasedPayments).toBeGreaterThanOrEqual(1);
    expect(summary.batchesCreated).toBe(1);
    const reassigned = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reassigned.settlementWindowId).not.toBeNull();
    expect(reassigned.settlementWindowId).not.toBe(cancelled.id);
    windowIds.add(reassigned.settlementWindowId!);
  });

  it("reconciles payable, allocated and malformed window totals", async () => {
    const reconciliationToken = token();
    const paid = await createPayment({
      merchantId: merchantA.id,
      token: reconciliationToken,
      amount: 1_000n,
      net: 900n,
    });
    const refunded = await createPayment({
      merchantId: merchantA.id,
      token: reconciliationToken,
      amount: 500n,
      net: 450n,
      refunded: 50n,
      status: "PARTIALLY_REFUNDED",
    });
    const good = track(
      await prisma.settlementWindow.create({
        data: {
          token: reconciliationToken,
          periodStart: old(),
          periodEnd: new Date(old().getTime() + 1_000),
          status: "EXECUTED",
          total: 1_300n,
          txHash: "b".repeat(64),
          auto: true,
          entries: {
            create: [
              { payee: merchantA.settlementAddress, amount: 900n, merchantId: merchantA.id },
              { payee: merchantB.settlementAddress, amount: 400n, merchantId: merchantA.id },
            ],
          },
        },
      }),
    );
    await prisma.payment.updateMany({
      where: { id: { in: [paid.id, refunded.id] } },
      data: { settlementWindowId: good.id, settlementAmount: 900n },
    });
    await prisma.payment.update({
      where: { id: refunded.id },
      data: { settlementAmount: 400n },
    });

    const report = await service.reconciliation(admin, {
      merchantId: merchantA.id,
      token: reconciliationToken,
    });
    expect(report.payments.count).toBe(2);
    expect(report.payments.gross).toBe("1500");
    expect(report.payments.fees).toBe("150");
    expect(report.payments.refunded).toBe("50");
    expect(report.payments.payable).toBe("1300");
    expect(report.payments.allocated).toBe("1300");
    expect(report.payments.unallocated).toBe("0");
    expect(report.treasury.feeRevenue).toBe("150");
    expect(report.invariants.windowTotalMismatch).toEqual([]);

    const badToken = token();
    const bad = track(
      await prisma.settlementWindow.create({
        data: {
          token: badToken,
          periodStart: old(),
          periodEnd: new Date(old().getTime() + 1_000),
          status: "CLOSED",
          total: 999n,
          auto: true,
          entries: {
            create: [{ payee: merchantA.settlementAddress, amount: 100n, merchantId: merchantA.id }],
          },
        },
      }),
    );

    const badReport = await service.reconciliation(admin, { token: badToken });
    expect(badReport.invariants.windowTotalMismatch).toHaveLength(1);
    expect(badReport.invariants.windowTotalMismatch[0]!.id).toBe(bad.id);
    expect(badReport.invariants.windowTotalMismatch[0]!.entryTotal).toBe("100");
  });

  it("does nothing when automation is disabled", async () => {
    const disabledConfig = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL!,
      JWT_SECRET: "dev-secret-that-is-at-least-32-characters-long",
      STELLAR_NETWORK: "testnet",
      SETTLEMENT_AUTOMATION: "off",
    });
    const disabled = new SettlementAutomationService(
      prisma,
      new SorobanService(disabledConfig),
      new AuditService(prisma),
      disabledConfig,
    );
    const summary: RunSummary = await disabled.run();
    expect(summary.skipped).toBe("automation_disabled");
    expect(summary.batchesCreated).toBe(0);
  });
});
