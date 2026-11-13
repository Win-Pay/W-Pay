import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import {
  MaintenanceController,
  MaintenanceService,
  type MaintenanceService as MaintenanceServiceType,
} from "./maintenance";
import type { AppConfig } from "./config";
import type { PrismaService } from "./prisma.service";
import type { WebhooksService } from "./webhooks/webhooks.service";

const indexerResults = [
  { fetched: 3, inserted: 2, skipped: 0, applied: 1, failed: 0, lastLedger: 42 },
];

vi.mock("@wpay/indexer/indexer", () => ({
  Indexer: class {
    async runOnce() {
      return indexerResults;
    }
  },
}));

function service(overrides: { drain?: () => Promise<number> } = {}) {
  const drain = vi.fn(overrides.drain ?? (async () => 2));
  const instance = new MaintenanceService(
    {} as PrismaService,
    { drain } as unknown as WebhooksService,
    {
      env: { STELLAR_RPC_URL: "https://rpc.example" },
      network: { rpcUrl: "https://fallback.example" },
      contracts: { paymentRouter: "C_PAYMENT" },
    } as unknown as AppConfig,
  );
  return { drain, instance };
}

function controller() {
  const run = vi.fn().mockResolvedValue({ ok: true, webhooks: { delivered: 0 } });
  return {
    run,
    instance: new MaintenanceController({ run } as unknown as MaintenanceServiceType),
  };
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("MaintenanceService", () => {
  it("drains webhooks and summarizes the indexer pass", async () => {
    const { instance } = service();
    await expect(instance.run()).resolves.toMatchObject({
      ok: true,
      webhooks: { delivered: 2, error: null },
      indexer: { contracts: 1, fetched: 3, inserted: 2, applied: 1, failed: 0 },
    });
  });

  it("reports a webhook failure without skipping the indexer", async () => {
    const { instance } = service({
      drain: async () => {
        throw new Error("database unavailable");
      },
    });
    const result = await instance.run();
    expect(result.ok).toBe(false);
    expect(result.webhooks).toMatchObject({ delivered: 0, error: "database unavailable" });
    expect(result.indexer).toMatchObject({ fetched: 3 });
  });
});

describe("MaintenanceController", () => {
  it("is hidden when no cron secret is configured", async () => {
    const { instance } = controller();
    await expect(instance.run(undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a caller without the cron credential", async () => {
    process.env.CRON_SECRET = "cron-secret-value";
    const { instance, run } = controller();
    await expect(instance.run(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(instance.run("Bearer wrong")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the maintenance pass with the matching bearer token", async () => {
    process.env.CRON_SECRET = "cron-secret-value";
    const { instance, run } = controller();
    await expect(instance.run("Bearer cron-secret-value")).resolves.toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("surfaces degraded passes with their diagnostics", async () => {
    process.env.CRON_SECRET = "cron-secret-value";
    const details = { ok: false, webhooks: { delivered: 0, error: "db down" } };
    const instance = new MaintenanceController({
      run: vi.fn().mockResolvedValue(details),
    } as unknown as MaintenanceServiceType);
    const error = await instance.run("Bearer cron-secret-value").catch((cause) => cause);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({ code: "MAINTENANCE_DEGRADED", details });
  });
});
