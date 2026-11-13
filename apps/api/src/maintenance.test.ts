import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { MaintenanceController, type MaintenanceService } from "./maintenance";

function controller() {
  const run = vi.fn().mockResolvedValue({ ok: true, webhooks: { delivered: 0 } });
  return {
    run,
    instance: new MaintenanceController({ run } as unknown as MaintenanceService),
  };
}

afterEach(() => {
  delete process.env.CRON_SECRET;
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
});
