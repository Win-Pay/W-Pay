/**
 * End-to-end database + API tests for the on-chain write path.
 *
 * The API is booted with contract ids configured, then the SorobanGateway is
 * replaced with a stub that returns real transaction envelopes and contract
 * events. This exercises argument verification, event verification and the
 * transactional database updates without touching a live network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Account,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@wpay/database";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const paymentRouter = StrKey.encodeContract(randomBytes(32));
const refundManager = StrKey.encodeContract(randomBytes(32));
const subscriptionManager = StrKey.encodeContract(randomBytes(32));

// Must be set before app.module/config.ts is imported (done dynamically below).
process.env.CONTRACT_PAYMENT_ROUTER_ID = paymentRouter;
process.env.CONTRACT_REFUND_MANAGER_ID = refundManager;
if (!process.env.STELLAR_NETWORK) process.env.STELLAR_NETWORK = "testnet";

const prisma = new PrismaClient();
const networkPassphrase = "Test SDF Network ; September 2015";
const run = `chain${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const created = {
  users: [] as string[],
  merchants: [] as string[],
  invoices: [] as string[],
  payments: [] as string[],
  refunds: [] as string[],
  plans: [] as string[],
  subscriptions: [] as string[],
};

function address(): string {
  return Keypair.random().publicKey();
}

function paymentEnvelope(input: {
  payer: string;
  merchantId: bigint;
  token: string;
  amount: bigint;
  memo: string;
}): string {
  const transaction = new TransactionBuilder(new Account(input.payer, "1"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      new Contract(paymentRouter).call(
        "create_payment",
        nativeToScVal(input.payer),
        nativeToScVal(input.merchantId, { type: "u64" }),
        nativeToScVal(input.token),
        nativeToScVal(input.amount, { type: "i128" }),
        nativeToScVal(input.memo),
      ),
    )
    .setTimeout(30)
    .build();
  return transaction.toXDR();
}

function paymentEvent(input: {
  txHash: string;
  contractPaymentId: bigint;
  payer: string;
  merchantId: bigint;
  amount: bigint;
  fee: bigint;
}) {
  return {
    txHash: input.txHash,
    topic: [
      nativeToScVal("payment", { type: "symbol" }),
      nativeToScVal(input.contractPaymentId, { type: "u64" }),
    ],
    value: nativeToScVal([input.payer, input.merchantId, input.amount, input.fee]),
  };
}

async function json<T>(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

describe.skipIf(!hasDatabase)("API on-chain write path", () => {
  let app: INestApplication;
  let baseUrl = "";
  let adminToken = "";
  let adminId = "";
  let merchantId = "";
  let registryId = 0n;
  let settlement = "";
  let walletToken = "";
  let walletAddress = "";
  const token = address();

  const getTransaction = vi.fn();
  const getEvents = vi.fn();

  function stubPayment(input: {
    txHash: string;
    payer: string;
    token: string;
    amount: bigint;
    fee: bigint;
    contractPaymentId: bigint;
    envelopeAmount?: bigint;
  }): void {
    getTransaction.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 900,
      envelopeXdr: paymentEnvelope({
        payer: input.payer,
        merchantId: registryId,
        token: input.token,
        amount: input.envelopeAmount ?? input.amount,
        memo: "test",
      }),
    });
    getEvents.mockResolvedValueOnce({
      events: [
        paymentEvent({
          txHash: input.txHash,
          contractPaymentId: input.contractPaymentId,
          payer: input.payer,
          merchantId: registryId,
          amount: input.amount,
          fee: input.fee,
        }),
      ],
    });
  }

  async function walletSession(): Promise<{ token: string; address: string }> {
    const keypair = Keypair.random();
    const challenge = await json<{ nonce: string; message: string }>(
      baseUrl,
      "/auth/wallet/challenge",
      { method: "POST", body: { address: keypair.publicKey() } },
    );
    expect(challenge.status).toBe(201);
    const signature = keypair
      .sign(Buffer.from(challenge.body.message, "utf8"))
      .toString("base64");
    const verified = await json<{ accessToken: string; user: { id: string; stellarAddress: string } }>(
      baseUrl,
      "/auth/wallet/verify",
      {
        method: "POST",
        body: { address: keypair.publicKey(), nonce: challenge.body.nonce, signature },
      },
    );
    expect(verified.status).toBe(201);
    created.users.push(verified.body.user.id);
    return { token: verified.body.accessToken, address: verified.body.user.stellarAddress };
  }

  beforeAll(async () => {
    const { createApp } = await import("./app");
    const { SorobanService } = await import("./soroban.service");
    app = await createApp({ swagger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");

    const soroban = app.get(SorobanService);
    Object.assign(soroban as unknown as { gateway: unknown }, {
      gateway: {
        hasContract: (name: string) =>
          name === "paymentRouter" ||
          name === "refundManager" ||
          name === "subscriptionManager",
        contractId: (name: string) =>
          name === "paymentRouter"
            ? paymentRouter
            : name === "refundManager"
              ? refundManager
              : subscriptionManager,
        prepareInvocation: vi.fn(async () => ({ toXDR: () => "AAAA-prepared" })),
        awaitTransaction: vi.fn(async (hash: string) => ({
          status: "SUCCESS",
          hash,
          ledger: 900,
          returnValue: 1n,
        })),
        server: { getTransaction, getEvents },
        submit: vi.fn(),
      },
    });

    const adminEmail = `chain-admin.${run}@wpay.test`;
    const registered = await json<{ accessToken: string; user: { id: string } }>(
      baseUrl,
      "/auth/register",
      { method: "POST", body: { email: adminEmail, password: "correct-horse-battery" } },
    );
    expect(registered.status).toBe(201);
    adminId = registered.body.user.id;
    created.users.push(adminId);
    await prisma.user.update({ where: { id: adminId }, data: { role: "ADMIN" } });
    const login = await json<{ accessToken: string }>(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: "correct-horse-battery" },
    });
    adminToken = login.body.accessToken;

    settlement = address();
    const merchant = await json<{ id: string }>(baseUrl, "/merchants", {
      method: "POST",
      token: adminToken,
      body: {
        name: `${run}-merchant`,
        ownerAddress: address(),
        settlementAddress: settlement,
        feeBps: 250,
      },
    });
    expect(merchant.status).toBe(201);
    merchantId = merchant.body.id;
    created.merchants.push(merchantId);
    registryId = BigInt(Date.now()) * 1000n + 7n;
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { status: "ACTIVE", registryId },
    });

    const wallet = await walletSession();
    walletToken = wallet.token;
    walletAddress = wallet.address;
  }, 60_000);

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { id: { in: created.subscriptions } } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: created.plans } } });
    await prisma.refund.deleteMany({ where: { id: { in: created.refunds } } });
    await prisma.payment.deleteMany({ where: { id: { in: created.payments } } });
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: created.users } } });
    await prisma.merchant.deleteMany({ where: { id: { in: created.merchants } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
    if (app) await app.close();
  }, 60_000);

  describe("payments", () => {
    let paymentId = "";
    const payer = address();
    const txHash = "1".repeat(64);

    it("returns a real intent without marking the payment settled", async () => {
      const response = await json<{
        payment: { id: string; status: string };
        transaction: { xdr: string; method: string } | null;
      }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "10000", payerAddress: payer, memo: "order" },
      });
      expect(response.status).toBe(201);
      expect(response.body.payment.status).toBe("PENDING");
      expect(response.body.transaction?.xdr).toBe("AAAA-prepared");
      expect(response.body.transaction?.method).toBe("create_payment");
      paymentId = response.body.payment.id;
      created.payments.push(paymentId);
    });

    it("settles only after matching the invocation and the payment event", async () => {
      stubPayment({
        txHash,
        payer,
        token,
        amount: 10000n,
        fee: 250n,
        contractPaymentId: 123n,
      });
      const response = await json<{ status: string; txHash: string; contractPaymentId: string }>(
        baseUrl,
        `/payments/${paymentId}/confirm`,
        { method: "POST", token: adminToken, body: { txHash } },
      );
      expect(response.status).toBe(201);
      expect(response.body.status).toBe("SETTLED");
      expect(response.body.txHash).toBe(txHash);
      expect(response.body.contractPaymentId).toBe("123");
    });

    it("treats a repeated confirmation of the same hash as idempotent", async () => {
      const response = await json<{ id: string; status: string }>(
        baseUrl,
        `/payments/${paymentId}/confirm`,
        { method: "POST", token: adminToken, body: { txHash } },
      );
      expect(response.status).toBe(201);
      expect(response.body.id).toBe(paymentId);
    });

    it("refuses to re-point a settled payment at another transaction", async () => {
      const response = await json<{ message: string }>(
        baseUrl,
        `/payments/${paymentId}/confirm`,
        { method: "POST", token: adminToken, body: { txHash: "2".repeat(64) } },
      );
      expect(response.status).toBe(409);
    });

    it("refuses a transaction whose event amount differs from the payment", async () => {
      const otherPayer = address();
      const created2 = await json<{ payment: { id: string } }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "20000", payerAddress: otherPayer },
      });
      const otherId = created2.body.payment.id;
      created.payments.push(otherId);

      const otherHash = "3".repeat(64);
      stubPayment({
        txHash: otherHash,
        payer: otherPayer,
        token,
        amount: 15000n,
        fee: 375n,
        contractPaymentId: 124n,
        envelopeAmount: 20000n,
      });
      const response = await json<{ message: string }>(baseUrl, `/payments/${otherId}/confirm`, {
        method: "POST",
        token: adminToken,
        body: { txHash: otherHash },
      });
      expect(response.status).toBe(400);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: otherId } });
      expect(row.status).toBe("PENDING");
      expect(row.txHash).toBeNull();
    });

    it("refuses to link the same contract payment id to two records", async () => {
      const payer = address();
      const first = await json<{ payment: { id: string } }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "40000", payerAddress: payer },
      });
      created.payments.push(first.body.payment.id);
      const firstHash = "a".repeat(64);
      stubPayment({
        txHash: firstHash,
        payer,
        token,
        amount: 40000n,
        fee: 1000n,
        contractPaymentId: 500n,
      });
      const settled = await json(baseUrl, `/payments/${first.body.payment.id}/confirm`, {
        method: "POST",
        token: adminToken,
        body: { txHash: firstHash },
      });
      expect(settled.status).toBe(201);

      const second = await json<{ payment: { id: string } }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "40000", payerAddress: payer },
      });
      created.payments.push(second.body.payment.id);
      const secondHash = "b".repeat(64);
      stubPayment({
        txHash: secondHash,
        payer,
        token,
        amount: 40000n,
        fee: 1000n,
        contractPaymentId: 500n,
      });
      const duplicate = await json<{ message: string }>(
        baseUrl,
        `/payments/${second.body.payment.id}/confirm`,
        { method: "POST", token: adminToken, body: { txHash: secondHash } },
      );
      expect(duplicate.status).toBe(409);
      const unchanged = await prisma.payment.findUniqueOrThrow({
        where: { id: second.body.payment.id },
      });
      expect(unchanged.status).toBe("PENDING");
    });
  });

  describe("invoices", () => {
    it("pays an invoice from the customer wallet and links both records", async () => {
      const customer = address();
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      const createdInvoice = await json<{ id: string; number: string }>(baseUrl, "/invoices", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "5000", dueAt, memo: "deposit" },
      });
      expect(createdInvoice.status).toBe(201);
      created.invoices.push(createdInvoice.body.id);

      const intent = await json<{ xdr: string; paymentId: string }>(
        baseUrl,
        `/invoices/public/${createdInvoice.body.number}/intent`,
        { method: "POST", body: { payer: customer } },
      );
      expect(intent.status).toBe(201);
      expect(intent.body.xdr).toBe("AAAA-prepared");
      expect(intent.body.paymentId).toBeTruthy();
      created.payments.push(intent.body.paymentId);

      const txHash = "4".repeat(64);
      stubPayment({
        txHash,
        payer: customer,
        token,
        amount: 5000n,
        fee: 125n,
        contractPaymentId: 200n,
      });
      const confirmed = await json<{
        status: string;
        paymentId: string;
        txHash: string;
      }>(baseUrl, `/invoices/public/${createdInvoice.body.number}/confirm`, {
        method: "POST",
        body: { txHash },
      });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.status).toBe("PAID");
      expect(confirmed.body.txHash).toBe(txHash);
      expect(confirmed.body.paymentId).toBe(intent.body.paymentId);

      const replay = await json<{ status: string }>(
        baseUrl,
        `/invoices/public/${createdInvoice.body.number}/confirm`,
        { method: "POST", body: { txHash } },
      );
      expect(replay.status).toBe(201);
      expect(replay.body.status).toBe("PAID");
    });

    it("settles an external payment even when no pending row was pre-created", async () => {
      const customer = address();
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      const createdInvoice = await json<{ id: string; number: string }>(baseUrl, "/invoices", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "9000", dueAt },
      });
      created.invoices.push(createdInvoice.body.id);

      const txHash = "9".repeat(64);
      stubPayment({
        txHash,
        payer: customer,
        token,
        amount: 9000n,
        fee: 225n,
        contractPaymentId: 202n,
      });
      const confirmed = await json<{ status: string; paymentId: string }>(
        baseUrl,
        `/invoices/public/${createdInvoice.body.number}/confirm`,
        { method: "POST", body: { txHash } },
      );
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.status).toBe("PAID");
      created.payments.push(confirmed.body.paymentId);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: confirmed.body.paymentId },
      });
      expect(payment.status).toBe("SETTLED");
      expect(payment.memo).toBe(createdInvoice.body.number);
    });

    it("refuses a transaction that does not match the invoice amount", async () => {
      const customer = address();
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      const createdInvoice = await json<{ id: string; number: string }>(baseUrl, "/invoices", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "6000", dueAt },
      });
      created.invoices.push(createdInvoice.body.id);
      const intent = await json<{ paymentId: string }>(
        baseUrl,
        `/invoices/public/${createdInvoice.body.number}/intent`,
        { method: "POST", body: { payer: customer } },
      );
      created.payments.push(intent.body.paymentId);

      const txHash = "5".repeat(64);
      stubPayment({
        txHash,
        payer: customer,
        token,
        amount: 7000n,
        fee: 175n,
        contractPaymentId: 201n,
      });
      const response = await json<{ message: string }>(
        baseUrl,
        `/invoices/public/${createdInvoice.body.number}/confirm`,
        { method: "POST", body: { txHash } },
      );
      expect(response.status).toBe(400);
      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: createdInvoice.body.id },
      });
      expect(row.status).toBe("OPEN");
    });
  });

  describe("refunds", () => {
    let walletPaymentId = "";
    const txHash = "6".repeat(64);

    beforeAll(async () => {
      const createdPayment = await json<{ payment: { id: string } }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: {
          merchantId,
          token,
          amount: "3000",
          payerAddress: walletAddress,
          memo: "refund-me",
        },
      });
      walletPaymentId = createdPayment.body.payment.id;
      created.payments.push(walletPaymentId);
      stubPayment({
        txHash,
        payer: walletAddress,
        token,
        amount: 3000n,
        fee: 75n,
        contractPaymentId: 300n,
      });
      const confirmed = await json(baseUrl, `/payments/${walletPaymentId}/confirm`, {
        method: "POST",
        token: adminToken,
        body: { txHash },
      });
      expect(confirmed.status).toBe(201);
    });

    it("builds the payer-signed refund request transaction", async () => {
      const request = await json<{ id: string; status: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "500", reason: "damaged" },
      });
      expect(request.status).toBe(201);
      const refundId = request.body.id;
      created.refunds.push(refundId);

      const intent = await json<{ xdr: string; method: string }>(
        baseUrl,
        `/refunds/${refundId}/intent`,
        { method: "POST", token: walletToken },
      );
      expect(intent.status).toBe(201);
      expect(intent.body.xdr).toBe("AAAA-prepared");
      expect(intent.body.method).toBe("request");

      await prisma.refund.update({
        where: { id: refundId },
        data: { contractRefundId: 55n, txHash: "7".repeat(64) },
      });

      const approved = await json<{
        refund: { status: string; contractRefundId: string };
        transaction: { method: string } | null;
      }>(baseUrl, `/refunds/${refundId}/approve`, { method: "POST", token: adminToken });
      expect(approved.status).toBe(201);
      expect(approved.body.refund.status).toBe("APPROVED");
      expect(approved.body.refund.contractRefundId).toBe("55");
      expect(approved.body.transaction?.method).toBe("approve");
    });

    it("only lets the payer build a refund request", async () => {
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);

      const stranger = await walletSession();
      const response = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/intent`,
        { method: "POST", token: stranger.token },
      );
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("only the refund payer");
    });

    it("refuses a second on-chain request once a contract id exists", async () => {
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);
      await prisma.refund.update({
        where: { id: request.body.id },
        data: { contractRefundId: 56n, txHash: "8".repeat(64) },
      });

      const response = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/intent`,
        { method: "POST", token: walletToken },
      );
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("already on chain");
    });

    it("refuses a request intent while the payment has no on-chain id", async () => {
      const pending = await json<{ payment: { id: string } }>(baseUrl, "/payments", {
        method: "POST",
        token: adminToken,
        body: {
          merchantId,
          token,
          amount: "400",
          payerAddress: walletAddress,
          memo: "not-on-chain",
        },
      });
      created.payments.push(pending.body.payment.id);
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: adminToken,
        body: { paymentId: pending.body.payment.id, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);

      const response = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/intent`,
        { method: "POST", token: walletToken },
      );
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("no on-chain id");
    });

    it("approves without fabricating a transaction when no contract id is linked", async () => {
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);

      const approved = await json<{ refund: { status: string }; transaction: null }>(
        baseUrl,
        `/refunds/${request.body.id}/approve`,
        { method: "POST", token: adminToken },
      );
      expect(approved.status).toBe(201);
      expect(approved.body.refund.status).toBe("APPROVED");
      expect(approved.body.transaction).toBeNull();

      const replay = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/approve`,
        { method: "POST", token: adminToken },
      );
      expect(replay.status).toBe(409);
      expect(replay.body.message).toContain("already decided");

      const rejected = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/reject`,
        { method: "POST", token: adminToken, body: { reason: "too late" } },
      );
      expect(rejected.status).toBe(409);
    });

    it("refuses approval from a wallet that is not the settlement wallet", async () => {
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);

      const response = await json<{ message: string }>(
        baseUrl,
        `/refunds/${request.body.id}/approve`,
        { method: "POST", token: walletToken },
      );
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("only the settlement wallet");
    });

    it("rejects a pending refund with a reason", async () => {
      const request = await json<{ id: string }>(baseUrl, "/refunds", {
        method: "POST",
        token: walletToken,
        body: { paymentId: walletPaymentId, amount: "100", reason: "late" },
      });
      expect(request.status).toBe(201);
      created.refunds.push(request.body.id);

      const rejected = await json<{ status: string; reason: string }>(
        baseUrl,
        `/refunds/${request.body.id}/reject`,
        { method: "POST", token: adminToken, body: { reason: "duplicate" } },
      );
      expect(rejected.status).toBe(201);
      expect(rejected.body.status).toBe("REJECTED");
      expect(rejected.body.reason).toContain("duplicate");
    });
  });

  describe("subscriptions", () => {
    it("builds subscribe and cancellation transactions from the wallet", async () => {
      const plan = await json<{ id: string }>(baseUrl, "/subscriptions/plans", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "250", intervalSecs: 2_592_000 },
      });
      expect(plan.status).toBe(201);
      created.plans.push(plan.body.id);
      await prisma.subscriptionPlan.update({
        where: { id: plan.body.id },
        data: { planIdOnChain: 77n },
      });

      const subscribed = await json<{
        subscription: { id: string };
        transaction: { method: string } | null;
      }>(baseUrl, "/subscriptions", {
        method: "POST",
        token: walletToken,
        body: { planId: plan.body.id, subscriber: walletAddress, cycles: 2 },
      });
      expect(subscribed.status).toBe(201);
      expect(subscribed.body.transaction?.method).toBe("subscribe");
      const subscriptionId = subscribed.body.subscription.id;
      created.subscriptions.push(subscriptionId);

      const missingChainId = await json<{ message: string }>(
        baseUrl,
        `/subscriptions/${subscriptionId}/cancel`,
        { method: "POST", token: walletToken },
      );
      expect(missingChainId.status).toBe(409);
      expect(missingChainId.body.message).toContain("no on-chain id");

      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { contractSubId: 88n },
      });
      const cancelled = await json<{ method: string; xdr: string }>(
        baseUrl,
        `/subscriptions/${subscriptionId}/cancel`,
        { method: "POST", token: walletToken },
      );
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.method).toBe("cancel");
      expect(cancelled.body.xdr).toBe("AAAA-prepared");
    });

    it("only lets the subscriber cancel", async () => {
      const plan = await json<{ id: string }>(baseUrl, "/subscriptions/plans", {
        method: "POST",
        token: adminToken,
        body: { merchantId, token, amount: "100", intervalSecs: 86_400 },
      });
      created.plans.push(plan.body.id);
      const subscribed = await json<{ subscription: { id: string } }>(
        baseUrl,
        "/subscriptions",
        {
          method: "POST",
          token: walletToken,
          body: { planId: plan.body.id, subscriber: walletAddress, cycles: 1 },
        },
      );
      expect(subscribed.status).toBe(201);
      created.subscriptions.push(subscribed.body.subscription.id);
      await prisma.subscription.update({
        where: { id: subscribed.body.subscription.id },
        data: { contractSubId: 89n },
      });

      const stranger = await walletSession();
      const response = await json<{ message: string }>(
        baseUrl,
        `/subscriptions/${subscribed.body.subscription.id}/cancel`,
        { method: "POST", token: stranger.token },
      );
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("only the subscriber");
    });
  });
});
