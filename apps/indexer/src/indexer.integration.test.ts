/**
 * Exercises the indexer projections against a real PostgreSQL database.
 * Skipped when DATABASE_URL is absent, matching the API integration suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { PrismaClient } from "@wpay/database";
import { Indexer, applyProjection } from "./indexer";
import type { Projection } from "./decode";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const prisma = new PrismaClient();

const run = `idx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseRegistry = BigInt(Date.now()) * 1000n;

const created = {
  merchants: [] as string[],
  payments: [] as string[],
  invoices: [] as string[],
  refunds: [] as string[],
  escrows: [] as string[],
  plans: [] as string[],
  subscriptions: [] as string[],
  windows: [] as string[],
  failures: [] as string[],
};

function address(): string {
  return Keypair.random().publicKey();
}

async function merchant(registryId: bigint | null = null, label = "m") {
  const owner = address();
  const row = await prisma.merchant.create({
    data: {
      ownerAddress: owner,
      settlementAddress: owner,
      name: `${run}-${label}`,
      registryId,
      status: registryId ? "ACTIVE" : "PENDING",
    },
  });
  created.merchants.push(row.id);
  return row;
}

async function apply(projection: Projection): Promise<boolean> {
  return prisma.$transaction((tx) => applyProjection(tx, projection));
}

describe.skipIf(!hasDatabase)("indexer projections", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.refund.deleteMany({ where: { id: { in: created.refunds } } });
    await prisma.payment.deleteMany({ where: { id: { in: created.payments } } });
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.escrow.deleteMany({ where: { id: { in: created.escrows } } });
    await prisma.subscription.deleteMany({ where: { id: { in: created.subscriptions } } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.settlementWindow.deleteMany({ where: { id: { in: created.windows } } });
    await prisma.indexerFailure.deleteMany({ where: { id: { in: created.failures } } });
    await prisma.merchant.deleteMany({ where: { id: { in: created.merchants } } });
    await prisma.$disconnect();
  });

  it("settles a pending payment and links its invoice by memo", async () => {
    const m = await merchant(baseRegistry + 1n, "payment");
    const payer = address();
    const invoice = await prisma.invoice.create({
      data: {
        number: `${run}-inv-1`,
        merchantId: m.id,
        token: "native",
        amount: 5000n,
        memo: `${run}-inv-1`,
        dueAt: new Date(Date.now() + 86_400_000),
      },
    });
    created.invoices.push(invoice.id);
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 5000n,
        fee: 125n,
        net: 4875n,
        memo: invoice.number,
      },
    });
    created.payments.push(payment.id);

    const projection: Projection = {
      type: "payment.settled",
      contractPaymentId: `${baseRegistry + 1n}1`,
      contractMerchantId: (baseRegistry + 1n).toString(),
      payer,
      amount: "5000",
      fee: "125",
      txHash: "a".repeat(64),
      ledger: 500,
    };
    expect(await apply(projection)).toBe(true);

    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(settled.status).toBe("SETTLED");
    expect(settled.contractPaymentId?.toString()).toBe(projection.contractPaymentId);
    expect(settled.txHash).toBe(projection.txHash);

    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.paymentId).toBe(payment.id);
    expect(paid.contractPaymentId?.toString()).toBe(projection.contractPaymentId);

    // Replaying the same event must not "re-settle" or re-link anything.
    expect(await apply(projection)).toBe(false);
  });

  it("refuses to settle when the on-chain amount does not match", async () => {
    const m = await merchant(baseRegistry + 2n, "mismatch");
    const payer = address();
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 6000n,
        fee: 150n,
        net: 5850n,
      },
    });
    created.payments.push(payment.id);

    expect(
      await apply({
        type: "payment.settled",
        contractPaymentId: `${baseRegistry + 2n}1`,
        contractMerchantId: (baseRegistry + 2n).toString(),
        payer,
        amount: "7000",
        fee: "175",
        txHash: "b".repeat(64),
        ledger: 501,
      }),
    ).toBe(false);
    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(unchanged.status).toBe("PENDING");
    expect(unchanged.txHash).toBeNull();
  });

  it("rolls back the whole projection when the transaction fails", async () => {
    const m = await merchant(baseRegistry + 3n, "rollback");
    const payer = address();
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 1000n,
        fee: 25n,
        net: 975n,
      },
    });
    created.payments.push(payment.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await applyProjection(tx, {
          type: "payment.settled",
          contractPaymentId: `${baseRegistry + 3n}1`,
          contractMerchantId: (baseRegistry + 3n).toString(),
          payer,
          amount: "1000",
          fee: "25",
          txHash: "c".repeat(64),
          ledger: 502,
        });
        throw new Error("simulated crash");
      }),
    ).rejects.toThrow("simulated crash");

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(unchanged.status).toBe("PENDING");
    expect(unchanged.contractPaymentId).toBeNull();
  });

  it("links refund requests and applies approvals and router refunds", async () => {
    const m = await merchant(baseRegistry + 4n, "refund");
    const payer = address();
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 500n,
        fee: 12n,
        net: 488n,
        status: "SETTLED",
        contractPaymentId: baseRegistry + 40n,
        txHash: "d".repeat(64),
        settledAt: new Date(),
      },
    });
    created.payments.push(payment.id);
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        merchantId: m.id,
        payerAddress: payer,
        amount: 500n,
        reason: "test",
      },
    });
    created.refunds.push(refund.id);

    expect(
      await apply({
        type: "refund.requested",
        contractRefundId: `${baseRegistry + 41n}`,
        contractPaymentId: payment.contractPaymentId!.toString(),
        amount: "500",
        txHash: "e".repeat(64),
        ledger: 510,
      }),
    ).toBe(true);
    expect(
      (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).contractRefundId?.toString(),
    ).toBe(`${baseRegistry + 41n}`);

    expect(
      await apply({
        type: "refund.approved",
        contractRefundId: `${baseRegistry + 41n}`,
        settlement: payer,
        amount: "500",
        txHash: "f".repeat(64),
        ledger: 511,
      }),
    ).toBe(true);
    const approved = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.txHash).toBe("f".repeat(64));

    expect(
      await apply({
        type: "payment.refunded",
        contractPaymentId: payment.contractPaymentId!.toString(),
        refunded: "500",
        txHash: "f".repeat(64),
        ledger: 511,
      }),
    ).toBe(true);
    const refunded = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(refunded.refunded).toBe(500n);
    expect(refunded.status).toBe("REFUNDED");
  });

  it("links escrow creation and applies state transitions", async () => {
    const m = await merchant(baseRegistry + 5n, "escrow");
    const payer = address();
    const payee = address();
    const escrow = await prisma.escrow.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        payeeAddress: payee,
        arbiterAddress: address(),
        token: "native",
        amount: 2500n,
        releaseAt: new Date(Date.now() + 86_400_000),
      },
    });
    created.escrows.push(escrow.id);

    expect(
      await apply({
        type: "escrow.created",
        contractEscrowId: `${baseRegistry + 51n}`,
        payer,
        payee,
        amount: "2500",
        releaseAt: Math.floor(Date.now() / 1000) + 86_400,
        txHash: "1".repeat(64),
        ledger: 520,
      }),
    ).toBe(true);
    const funded = await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } });
    expect(funded.status).toBe("FUNDED");
    expect(funded.contractEscrowId?.toString()).toBe(`${baseRegistry + 51n}`);

    expect(
      await apply({
        type: "escrow.status",
        contractEscrowId: `${baseRegistry + 51n}`,
        status: "RELEASED",
        txHash: "2".repeat(64),
        ledger: 521,
      }),
    ).toBe(true);
    expect((await prisma.escrow.findUniqueOrThrow({ where: { id: escrow.id } })).status).toBe(
      "RELEASED",
    );
  });

  it("links invoices and their paid events", async () => {
    const m = await merchant(baseRegistry + 6n, "invoice");
    const invoice = await prisma.invoice.create({
      data: {
        number: `${run}-inv-6`,
        merchantId: m.id,
        token: "native",
        amount: 8000n,
        dueAt: new Date(Date.now() + 86_400_000),
      },
    });
    created.invoices.push(invoice.id);

    expect(
      await apply({
        type: "invoice.created",
        contractInvoiceId: `${baseRegistry + 61n}`,
        owner: m.ownerAddress,
        contractMerchantId: (baseRegistry + 6n).toString(),
        amount: "8000",
        txHash: "3".repeat(64),
        ledger: 530,
      }),
    ).toBe(true);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).contractInvoiceId?.toString(),
    ).toBe(`${baseRegistry + 61n}`);

    expect(
      await apply({
        type: "invoice.paid",
        contractInvoiceId: `${baseRegistry + 61n}`,
        payer: address(),
        txHash: "4".repeat(64),
        ledger: 531,
      }),
    ).toBe(true);
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).not.toBeNull();
  });

  it("synchronizes subscription lifecycle events", async () => {
    const m = await merchant(baseRegistry + 7n, "subscription");
    const plan = await prisma.subscriptionPlan.create({
      data: { merchantId: m.id, token: "native", amount: 1000n, intervalSecs: 86_400 },
    });
    created.plans.push(plan.id);

    expect(
      await apply({
        type: "plan.created",
        planIdOnChain: `${baseRegistry + 71n}`,
        contractMerchantId: (baseRegistry + 7n).toString(),
        amount: "1000",
        txHash: "5".repeat(64),
        ledger: 540,
      }),
    ).toBe(true);
    expect(
      (await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: plan.id } })).planIdOnChain?.toString(),
    ).toBe(`${baseRegistry + 71n}`);

    const subscriber = address();
    const subscription = await prisma.subscription.create({
      data: { planId: plan.id, subscriber, prepaid: 2000n, nextDueAt: new Date() },
    });
    created.subscriptions.push(subscription.id);

    expect(
      await apply({
        type: "subscription.created",
        contractSubId: `${baseRegistry + 72n}`,
        planIdOnChain: `${baseRegistry + 71n}`,
        subscriber,
        cycles: "2",
        txHash: "6".repeat(64),
        ledger: 541,
      }),
    ).toBe(true);

    expect(
      await apply({
        type: "subscription.charged",
        contractSubId: `${baseRegistry + 72n}`,
        cyclesCharged: "2",
        amount: "2000",
        txHash: "7".repeat(64),
        ledger: 542,
      }),
    ).toBe(true);
    const charged = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(charged.cyclesCharged).toBe(2);
    expect(charged.prepaid).toBe(0n);

    expect(
      await apply({
        type: "subscription.cancelled",
        contractSubId: `${baseRegistry + 72n}`,
        subscriber,
        txHash: "8".repeat(64),
        ledger: 543,
      }),
    ).toBe(true);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status,
    ).toBe("CANCELLED");
  });

  it("synchronizes settlement window open, close and execute", async () => {
    const m = await merchant(baseRegistry + 8n, "settlement");
    const periodStart = new Date(Math.floor(Date.now() / 1000) * 1000);
    const periodEnd = new Date(periodStart.getTime() + 86_400_000);
    const window = await prisma.settlementWindow.create({
      data: { merchantId: m.id, token: "native", periodStart, periodEnd },
    });
    created.windows.push(window.id);

    expect(
      await apply({
        type: "settlement.opened",
        windowIdOnChain: `${baseRegistry + 81n}`,
        token: "native",
        periodStart: Math.floor(periodStart.getTime() / 1000),
        periodEnd: Math.floor(periodEnd.getTime() / 1000),
        txHash: "9".repeat(64),
        ledger: 550,
      }),
    ).toBe(true);
    expect(
      await apply({
        type: "settlement.closed",
        windowIdOnChain: `${baseRegistry + 81n}`,
        total: "3000",
        txHash: "a".repeat(64),
        ledger: 551,
      }),
    ).toBe(true);
    expect(
      await apply({
        type: "settlement.executed",
        windowIdOnChain: `${baseRegistry + 81n}`,
        total: "3000",
        operator: m.ownerAddress,
        txHash: "b".repeat(64),
        ledger: 552,
      }),
    ).toBe(true);

    const executed = await prisma.settlementWindow.findUniqueOrThrow({ where: { id: window.id } });
    expect(executed.status).toBe("EXECUTED");
    expect(executed.total).toBe(3000n);
    expect(executed.executedAt).not.toBeNull();
  });

  it("links merchant registration and status changes", async () => {
    const m = await merchant(null, "registry");
    const registryId = baseRegistry + 91n;
    expect(
      await apply({
        type: "merchant.registered",
        registryId: registryId.toString(),
        owner: m.ownerAddress,
        txHash: "c".repeat(64),
        ledger: 560,
      }),
    ).toBe(true);
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).registryId).toBe(
      registryId,
    );

    expect(
      await apply({
        type: "merchant.status",
        registryId: registryId.toString(),
        status: "SUSPENDED",
        txHash: "d".repeat(64),
        ledger: 561,
      }),
    ).toBe(true);
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).status).toBe(
      "SUSPENDED",
    );

    const settlement = address();
    expect(
      await apply({
        type: "merchant.settlement",
        registryId: registryId.toString(),
        settlement,
        txHash: "e".repeat(64),
        ledger: 562,
      }),
    ).toBe(true);
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).settlementAddress,
    ).toBe(settlement);
  });

  it("retries a failed projection and resolves it once the record becomes linkable", async () => {
    const m = await merchant(baseRegistry + 10n, "retry");
    const payer = address();
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 2500n,
        fee: 62n,
        net: 2438n,
      },
    });
    created.payments.push(payment.id);

    const failure = await prisma.indexerFailure.create({
      data: {
        contractId: "C_RETRY",
        eventIndex: `${run}-retry`,
        txHash: "e".repeat(64),
        ledger: 700,
        kind: "settle",
        reason: "projection could not match a unique local record",
        projection: {
          type: "payment.settled",
          contractPaymentId: `${baseRegistry + 10n}9`,
          contractMerchantId: (baseRegistry + 10n).toString(),
          payer,
          amount: "2500",
          fee: "62",
          txHash: "e".repeat(64),
          ledger: 700,
        },
      },
    });
    created.failures.push(failure.id);

    const indexer = new Indexer(prisma, {
      rpcUrl: "http://127.0.0.1:1",
      contracts: {},
      startLedger: 1,
      batchSize: 10,
    });
    const result = await indexer.retryFailures();
    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(settled.status).toBe("SETTLED");
    const row = await prisma.indexerFailure.findUniqueOrThrow({ where: { id: failure.id } });
    expect(row.resolvedAt).not.toBeNull();
    expect(row.attempts).toBeGreaterThan(1);
  });

  it("keeps an unmatched projection in the dead-letter queue with attempt history", async () => {
    const m = await merchant(baseRegistry + 11n, "dead");
    const payer = address();
    const payment = await prisma.payment.create({
      data: {
        merchantId: m.id,
        payerAddress: payer,
        token: "native",
        amount: 900n,
        fee: 22n,
        net: 878n,
      },
    });
    created.payments.push(payment.id);

    const failure = await prisma.indexerFailure.create({
      data: {
        contractId: "C_DEAD",
        eventIndex: `${run}-dead`,
        txHash: "f".repeat(64),
        ledger: 701,
        kind: "settle",
        reason: "projection could not match a unique local record",
        projection: {
          type: "payment.settled",
          contractPaymentId: `${baseRegistry + 11n}8`,
          contractMerchantId: (baseRegistry + 11n).toString(),
          payer,
          amount: "9999",
          fee: "22",
          txHash: "f".repeat(64),
          ledger: 701,
        },
      },
    });
    created.failures.push(failure.id);

    const indexer = new Indexer(prisma, {
      rpcUrl: "http://127.0.0.1:1",
      contracts: {},
      startLedger: 1,
      batchSize: 10,
    });
    await indexer.retryFailures();

    const row = await prisma.indexerFailure.findUniqueOrThrow({ where: { id: failure.id } });
    expect(row.resolvedAt).toBeNull();
    expect(row.attempts).toBeGreaterThan(1);
    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(unchanged.status).toBe("PENDING");
  });
});
