import { describe, expect, it } from "vitest";
import {
  classifySettlementFailure,
  formatSettlementMetrics,
  SETTLEMENT_FAILURE_REASONS,
  type SettlementMetricsSnapshot,
} from "./metrics";

function snapshot(overrides: Partial<SettlementMetricsSnapshot> = {}): SettlementMetricsSnapshot {
  return {
    mode: "execute",
    eligiblePayments: 3,
    pendingWindows: { OPEN: 2, CLOSED: 1 },
    oldestPendingAgeSeconds: 90,
    runs: { success: 5, failure: 1 },
    retries: Object.fromEntries(
      SETTLEMENT_FAILURE_REASONS.map((reason) => [reason, 0]),
    ) as SettlementMetricsSnapshot["retries"],
    lastSuccessAt: new Date("2026-11-23T10:00:00.000Z"),
    execution: {
      count: 2,
      sumSeconds: 6,
      quantiles: [
        { quantile: 0.5, value: 3 },
        { quantile: 0.95, value: 5.7 },
        { quantile: 1, value: 6 },
      ],
    },
    reconciliation: {
      executed_auto_window_without_tx: 0,
      paid_invoice_without_payment: 1,
      settled_payment_without_contract: 0,
    },
    indexer: { checkpoints: 5, lagSeconds: 12, unresolvedFailures: 0 },
    ...overrides,
  };
}

describe("classifySettlementFailure", () => {
  it.each([
    ["insufficient pool balance for window", "insufficient_pool"],
    ["rpc timeout while reading window", "rpc_unavailable"],
    ["window state mismatch: expected CLOSED", "state_mismatch"],
    ["transaction budget exceeded", "budget_exceeded"],
    ["window was cancelled by an operator", "cancelled"],
    ["operator key is not authorized", "other"],
    [null, "other"],
  ] as const)("maps %s to %s", (message, reason) => {
    expect(classifySettlementFailure(message)).toBe(reason);
  });
});

describe("formatSettlementMetrics", () => {
  it("exposes the required settlement gauges and summary", () => {
    const text = formatSettlementMetrics(snapshot());
    expect(text).toContain("wpay_settlement_eligible_payments 3");
    expect(text).toContain('wpay_settlement_pending_windows{status="OPEN"} 2');
    expect(text).toContain('wpay_settlement_pending_windows{status="CLOSED"} 1');
    expect(text).toContain("wpay_settlement_oldest_pending_age_seconds 90");
    expect(text).toContain('wpay_settlement_automation_runs_total{outcome="success"} 5');
    expect(text).toContain('wpay_settlement_automation_runs_total{outcome="failure"} 1');
    expect(text).toContain(
      `wpay_settlement_last_success_timestamp_seconds ${Math.floor(
        new Date("2026-11-23T10:00:00.000Z").getTime() / 1_000,
      )}`,
    );
    expect(text).toContain(
      'wpay_settlement_execution_duration_seconds{quantile="0.95"} 5.700',
    );
    expect(text).toContain("wpay_settlement_execution_duration_seconds_sum 6.000");
    expect(text).toContain("wpay_settlement_execution_duration_seconds_count 2");
    expect(text).toContain('wpay_settlement_automation_enabled{mode="execute"} 1');
    expect(text).toContain("wpay_settlement_worker_up 1");
    expect(text).toContain("wpay_api_indexer_unresolved_failures 0");
    expect(text).toContain('wpay_settlement_reconciliation_failures{check="total"} 1');
  });

  it("always emits each bounded reason and never a wallet address", () => {
    const text = formatSettlementMetrics(
      snapshot({
        mode: "off",
        retries: { insufficient_pool: 2, rpc_unavailable: 0, state_mismatch: 0, budget_exceeded: 0, cancelled: 0, other: 0 },
        indexer: { checkpoints: 0, lagSeconds: null, unresolvedFailures: 3 },
      }),
    );
    for (const reason of SETTLEMENT_FAILURE_REASONS) {
      expect(text).toContain(`wpay_settlement_retries_total{reason="${reason}"}`);
    }
    expect(text).toContain('wpay_settlement_retries_total{reason="insufficient_pool"} 2');
    expect(text).toContain('wpay_settlement_automation_enabled{mode="off"} 1');
    expect(text).toContain("wpay_settlement_worker_up 0");
    expect(text).toContain("wpay_api_indexer_up 0");
    expect(text).toContain("wpay_api_indexer_checkpoint_age_seconds 0");
    // No Stellar account or contract addresses may appear anywhere in the payload.
    expect(text).not.toMatch(/\b[GC][A-Z2-7]{55}\b/);
  });
});
