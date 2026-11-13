/**
 * Unit tests for the Soroban intent layer.
 *
 * The gateway is replaced with a stub, so these tests assert the contract of
 * this module only: unconfigured contracts must yield `null` (never a fake
 * transaction), failures must be swallowed into `null` rather than thrown, and
 * `submit` must translate the gateway outcome faithfully.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { AppConfig } from "./config";
import { SorobanService } from "./soroban.service";

const contractId = StrKey.encodeContract(randomBytes(32));
const address = Keypair.random().publicKey();

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://unused",
      JWT_SECRET: "x".repeat(32),
      JWT_EXPIRES_IN: "1h",
      STELLAR_NETWORK: "testnet",
      API_PORT: 4000,
      API_PUBLIC_URL: "http://localhost:4000",
      WEB_PUBLIC_URL: "http://localhost:3000",
      ADMIN_ADDRESSES: "",
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    },
    contracts: {},
    adminAddresses: [],
    network: {
      name: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
    ...overrides,
  } as AppConfig;
}

describe("SorobanService", () => {
  describe("with no contracts configured", () => {
    let service: SorobanService;

    beforeEach(() => {
      service = new SorobanService(config());
    });

    it("reports itself as unconfigured", () => {
      expect(service.configured).toBe(false);
      expect(service.has("paymentRouter")).toBe(false);
    });

    it("has no operator signer without SOROBAN_SOURCE_SECRET", () => {
      expect(service.operatorSigner()).toBeNull();
    });

    it("returns null instead of fabricating any transaction", async () => {
      await expect(
        service.paymentIntent({
          payer: address,
          merchantId: 1n,
          token: address,
          amount: 100n,
          memo: "m",
        }),
      ).resolves.toBeNull();
      await expect(
        service.escrowIntent({
          payer: address,
          payee: address,
          arbiter: address,
          token: address,
          amount: 1n,
          releaseAt: 0,
        }),
      ).resolves.toBeNull();
      await expect(service.approveRefundIntent(address, 1n)).resolves.toBeNull();
      await expect(service.pauseAllIntent(address)).resolves.toBeNull();
      await expect(service.withdrawIntent({ admin: address, token: address, to: address, amount: 1n }))
        .resolves.toBeNull();
    });
  });

  describe("with a configured contract", () => {
    let service: SorobanService;
    let prepareInvocation: ReturnType<typeof vi.fn>;
    let gateway: {
      hasContract: (name: string) => boolean;
      contractId: (name: string) => string;
      prepareInvocation: typeof prepareInvocation;
      submit: ReturnType<typeof vi.fn>;
      awaitTransaction: ReturnType<typeof vi.fn>;
      server: {
        getTransaction: ReturnType<typeof vi.fn>;
        getEvents: ReturnType<typeof vi.fn>;
      };
    };

    beforeEach(() => {
      service = new SorobanService(config({ contracts: { paymentRouter: contractId } }));
      prepareInvocation = vi.fn(async () => ({ toXDR: () => "AAAA-prepared" }));
      gateway = {
        // Only the payment router is configured in this fixture.
        hasContract: (name: string) => name === "paymentRouter",
        contractId: () => contractId,
        prepareInvocation,
        submit: vi.fn(async () => ({ hash: "deadbeef" })),
        awaitTransaction: vi.fn(async () => ({ status: "SUCCESS", ledger: 42, returnValue: 1 })),
        server: {
          getTransaction: vi.fn(),
          getEvents: vi.fn(async () => ({ events: [] })),
        },
      };
      // Replace the real RPC-backed gateway for the duration of the test.
      Object.assign(service as unknown as { gateway: unknown }, { gateway });
    });

    it("builds a payment intent the wallet can sign", async () => {
      const intent = await service.paymentIntent({
        payer: address,
        merchantId: 7n,
        token: address,
        amount: 5_000_000n,
        memo: "order-7",
      });
      expect(intent).not.toBeNull();
      expect(intent!.xdr).toBe("AAAA-prepared");
      expect(intent!.contractId).toBe(contractId);
      expect(intent!.networkPassphrase).toBe("Test SDF Network ; September 2015");
      expect(intent!.description.length).toBeGreaterThan(0);
      expect(prepareInvocation).toHaveBeenCalledTimes(1);
    });

    it("verifies a successful transaction against its payment event", async () => {
      const payer = Keypair.random().publicKey();
      const token = Keypair.random().publicKey();
      const merchantId = 7n;
      const amount = 5_000n;
      const fee = 125n;
      const txHash = "a".repeat(64);
      const transaction = new TransactionBuilder(new Account(payer, "1"), {
        fee: "100",
        networkPassphrase: "Test SDF Network ; September 2015",
      })
        .addOperation(
          new Contract(contractId).call(
            "create_payment",
            nativeToScVal(payer),
            nativeToScVal(merchantId, { type: "u64" }),
            nativeToScVal(token),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal("order-7"),
          ),
        )
        .setTimeout(30)
        .build();

      gateway.server.getTransaction.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 42,
        envelopeXdr: transaction.toXDR(),
      });
      gateway.server.getEvents.mockResolvedValue({
        events: [
          {
            txHash,
            topic: [
              nativeToScVal("payment", { type: "symbol" }),
              nativeToScVal(99n, { type: "u64" }),
            ],
            value: nativeToScVal([payer, merchantId, amount, fee]),
          },
        ],
      });

      const verified = await service.verifyPaymentTransaction(txHash, 42, {
        payer,
        merchantId,
        token,
        amount,
        memo: "order-7",
      });
      expect(verified).toMatchObject({
        contractPaymentId: 99n,
        payer,
        merchantId,
        token,
        amount,
        fee,
        memo: "order-7",
      });

      await expect(
        service.verifyPaymentTransaction(txHash, 42, {
          payer,
          merchantId,
          token,
          amount: amount + 1n,
        }),
      ).resolves.toBeNull();

      // The memo binds the transaction to the invoice/payment it is meant to
      // settle; a transaction for the right amount but another memo is rejected.
      await expect(
        service.verifyPaymentTransaction(txHash, 42, {
          merchantId,
          token,
          amount,
          memo: "INV-OTHER",
        }),
      ).resolves.toBeNull();
    });

    it("returns null and logs when the gateway fails to prepare", async () => {
      prepareInvocation.mockRejectedValueOnce(new Error("rpc unavailable"));
      await expect(service.releaseEscrowIntent(address, 3n)).resolves.toBeNull();
    });

    it("treats an unknown contract as unconfigured", async () => {
      gateway.hasContract = () => false;
      await expect(
        service.createPlanIntent({ owner: address, merchantId: 1n, token: address, amount: 1n, intervalSecs: 60 }),
      ).resolves.toBeNull();
      expect(prepareInvocation).not.toHaveBeenCalled();
    });

    it("does not build an intent when the contract is absent from config", async () => {
      // paymentRouter is configured, invoiceManager is not.
      await expect(
        service.invoiceIntent({
          owner: address,
          merchantId: 1n,
          token: address,
          amount: 1n,
          dueAt: 0,
          memo: "m",
        }),
      ).resolves.toBeNull();
    });

    it("maps a successful submission to a ledger-confirmed status", async () => {
      const result = await service.submit("signed-xdr");
      expect(result).toEqual({
        hash: "deadbeef",
        status: "SUCCESS",
        ledger: 42,
        returnValue: 1,
      });
    });

    it("reports a failed submission without a return value", async () => {
      gateway.awaitTransaction.mockResolvedValueOnce({ status: "FAILED" });
      const result = await service.submit("signed-xdr");
      expect(result.status).toBe("FAILED");
      expect(result.returnValue).toBeUndefined();
      expect(result.ledger).toBeUndefined();
    });

    it("reports an unfound transaction honestly", async () => {
      gateway.awaitTransaction.mockResolvedValueOnce({ status: "NOT_FOUND" });
      await expect(service.submit("signed-xdr")).resolves.toMatchObject({ status: "NOT_FOUND" });
    });
  });

  describe("operator signer", () => {
    it("derives a signer from SOROBAN_SOURCE_SECRET", () => {
      const keypair = Keypair.random();
      const service = new SorobanService(
        config({ sorobanSourceSecret: keypair.secret(), contracts: { paymentRouter: contractId } }),
      );
      const signer = service.operatorSigner();
      expect(signer).not.toBeNull();
      expect(signer!.publicKey).toBe(keypair.publicKey());
    });
  });
});
