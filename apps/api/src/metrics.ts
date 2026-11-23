import { Prisma, type PrismaClient } from "@wpay/database";
import type { AppConfig } from "./config";

/**
 * Prometheus metrics for the settlement automation.
 *
 * Every label is a bounded enum. Wallet addresses, merchant names, memos,
 * transaction hashes, contract ids and error text never become labels or
 * metric values; errors are reduced to one of the reasons below.
 *
 * Values are derived from Postgres rather than process memory so they survive
 * cold starts and are consistent across serverless instances. Counters are
 * therefore "current rows/attempts in the database", not per-request counters.
 */

export const SETTLEMENT_FAILURE_REASONS = [
  "insufficient_pool",
  "rpc_unavailable",
  "state_mismatch",
  "budget_exceeded",
  "cancelled",
  "other",
] as const;

export type SettlementFailureReason = (typeof SETTLEMENT_FAILURE_REASONS)[number];

const ELIGIBLE_STATUSES = ["SETTLED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const PENDING_STATUSES = ["OPEN", "CLOSED"] as const;
const RECONCILIATION_CHECKS = [
  "executed_auto_window_without_tx",
  "paid_invoice_without_payment",
  "settled_payment_without_contract",
] as const;

/** Maps free-form worker errors onto a bounded label set. */
export function classifySettlementFailure(message: string | null | undefined): SettlementFailureReason {
  const text = (message ?? "").toLowerCase();
  if (!text) return "other";
  if (/(insufficient|underfunded|pool|balance too low|not enough funds)/.test(text)) {
    return "insufficient_pool";
  }
  if (/(cancel)/.test(text)) return "cancelled";
  if (/(budget|resource|fee too|exceeded maximum|limit)/.test(text)) return "budget_exceeded";
  if (/(mismatch|does not match|unexpected|invalid state|state)/.test(text)) {
    return "state_mismatch";
  }
  if (/(rpc|timeout|timed out|unavailable|network|econn|fetch failed|502|503|504)/.test(text)) {
    return "rpc_unavailable";
  }
  return "other";
}

export interface SettlementMetricsSnapshot {
  mode: "off" | "prepare" | "execute";
  eligiblePayments: number;
  pendingWindows: Record<string, number>;
  oldestPendingAgeSeconds: number;
  runs: { success: number; failure: number };
  retries: Record<SettlementFailureReason, number>;
  lastSuccessAt: Date | null;
  execution: {
    count: number;
    sumSeconds: number;
    quantiles: { quantile: number; value: number }[];
  };
  reconciliation: Record<string, number>;
  indexer: {
    checkpoints: number;
    lagSeconds: number | null;
    unresolvedFailures: number;
  };
}

function modeOf(config: AppConfig): SettlementMetricsSnapshot["mode"] {
  const mode = config.env.SETTLEMENT_AUTOMATION;
  return mode === "prepare" || mode === "execute" ? mode : "off";
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export async function collectSettlementMetrics(
  prisma: PrismaClient,
  config: AppConfig,
): Promise<SettlementMetricsSnapshot> {
  const holdHours = Math.max(0, Number(config.env.SETTLEMENT_HOLD_HOURS ?? 24));
  const now = Date.now();

  const [eligibleRows, grouped, oldest, failing, successRuns, lastSuccess, durations, ...recon] =
    await Promise.all([
      prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Payment" p
        WHERE p.status::text IN ('SETTLED','PARTIALLY_REFUNDED','REFUNDED')
          AND p."settlementWindowId" IS NULL
          AND p."settledAt" IS NOT NULL
          AND (p.net - p.refunded) > 0
          AND p."settledAt" <= NOW() - make_interval(hours => ${holdHours}::int)
      `),
      prisma.settlementWindow.groupBy({
        by: ["status"],
        where: { auto: true, status: { in: [...PENDING_STATUSES] } },
        _count: { _all: true },
      }),
      prisma.settlementWindow.findFirst({
        where: { auto: true, status: { in: [...PENDING_STATUSES] } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.settlementWindow.findMany({
        where: { auto: true, attempts: { gt: 0 }, status: { not: "EXECUTED" } },
        select: { attempts: true, lastError: true },
      }),
      prisma.settlementWindow.count({ where: { auto: true, status: "EXECUTED" } }),
      prisma.settlementWindow.findFirst({
        where: { auto: true, status: "EXECUTED", executedAt: { not: null } },
        orderBy: { executedAt: "desc" },
        select: { executedAt: true },
      }),
      prisma.settlementWindow.findMany({
        where: { auto: true, status: "EXECUTED", executedAt: { not: null } },
        orderBy: { executedAt: "desc" },
        take: 500,
        select: { createdAt: true, executedAt: true },
      }),
      prisma.settlementWindow.count({
        where: { auto: true, status: "EXECUTED", txHash: null },
      }),
      prisma.invoice.count({ where: { status: "PAID", paymentId: null } }),
      prisma.payment.count({
        where: { status: { in: [...ELIGIBLE_STATUSES] }, contractPaymentId: null },
      }),
      prisma.indexerCheckpoint.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
      prisma.indexerCheckpoint.count(),
      prisma.indexerFailure.count({ where: { resolvedAt: null } }),
    ]);

  const pendingWindows: Record<string, number> = {};
  for (const status of PENDING_STATUSES) pendingWindows[status] = 0;
  for (const row of grouped) {
    pendingWindows[row.status] = row._count._all;
  }

  const retries = Object.fromEntries(
    SETTLEMENT_FAILURE_REASONS.map((reason) => [reason, 0]),
  ) as Record<SettlementFailureReason, number>;
  let failureRuns = 0;
  for (const row of failing) {
    retries[classifySettlementFailure(row.lastError)] += Math.max(0, row.attempts);
    failureRuns += 1;
  }

  const seconds = durations
    .filter((row) => row.executedAt !== null)
    .map((row) => Math.max(0, (row.executedAt!.getTime() - row.createdAt.getTime()) / 1_000))
    .sort((a, b) => a - b);
  const execution = {
    count: seconds.length,
    sumSeconds: seconds.reduce((sum, value) => sum + value, 0),
    quantiles: [0.5, 0.95, 1].map((q) => ({ quantile: q, value: quantile(seconds, q) })),
  };

  const reconciliation = {
    executed_auto_window_without_tx: recon[0] as number,
    paid_invoice_without_payment: recon[1] as number,
    settled_payment_without_contract: recon[2] as number,
  };

  const latestCheckpoint = recon[3] as { updatedAt: Date } | null;
  const indexer = {
    checkpoints: recon[4] as number,
    lagSeconds: latestCheckpoint
      ? Math.max(0, Math.floor((now - latestCheckpoint.updatedAt.getTime()) / 1_000))
      : null,
    unresolvedFailures: recon[5] as number,
  };

  return {
    mode: modeOf(config),
    eligiblePayments: eligibleRows[0]?.count ?? 0,
    pendingWindows,
    oldestPendingAgeSeconds: oldest
      ? Math.max(0, Math.floor((now - oldest.createdAt.getTime()) / 1_000))
      : 0,
    runs: { success: successRuns, failure: failureRuns },
    retries,
    lastSuccessAt: lastSuccess?.executedAt ?? null,
    execution,
    reconciliation,
    indexer,
  };
}

function count(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.max(0, Math.round(value)));
}

function seconds(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.max(0, value).toFixed(3);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Renders the exposition text. Pure so formatting is unit-testable. */
export function formatSettlementMetrics(snapshot: SettlementMetricsSnapshot): string {
  const lines: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: "gauge" | "counter" | "summary",
    samples: string[],
  ): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };

  metric(
    "wpay_settlement_eligible_payments",
    "Settled payments with unallocated net above zero after the hold period",
    "gauge",
    [`wpay_settlement_eligible_payments ${count(snapshot.eligiblePayments)}`],
  );

  metric(
    "wpay_settlement_pending_windows",
    "Automatic settlement windows that are not executed or cancelled, by status",
    "gauge",
    PENDING_STATUSES.map(
      (status) =>
        `wpay_settlement_pending_windows{status="${escapeLabel(status)}"} ${count(
          snapshot.pendingWindows[status] ?? 0,
        )}`,
    ),
  );

  metric(
    "wpay_settlement_oldest_pending_age_seconds",
    "Age of the oldest automatic settlement window that is still pending",
    "gauge",
    [`wpay_settlement_oldest_pending_age_seconds ${count(snapshot.oldestPendingAgeSeconds)}`],
  );

  metric(
    "wpay_settlement_automation_runs_total",
    "Automatic settlement batches executed successfully, and batches currently in backoff",
    "gauge",
    [
      `wpay_settlement_automation_runs_total{outcome="success"} ${count(snapshot.runs.success)}`,
      `wpay_settlement_automation_runs_total{outcome="failure"} ${count(snapshot.runs.failure)}`,
    ],
  );

  metric(
    "wpay_settlement_retries_total",
    "Failed automatic settlement attempts grouped by bounded failure reason",
    "gauge",
    SETTLEMENT_FAILURE_REASONS.map(
      (reason) =>
        `wpay_settlement_retries_total{reason="${escapeLabel(reason)}"} ${count(
          snapshot.retries[reason] ?? 0,
        )}`,
    ),
  );

  metric(
    "wpay_settlement_last_success_timestamp_seconds",
    "Unix timestamp of the last executed automatic settlement batch; 0 when none exists",
    "gauge",
    [
      `wpay_settlement_last_success_timestamp_seconds ${
        snapshot.lastSuccessAt ? Math.floor(snapshot.lastSuccessAt.getTime() / 1_000) : 0
      }`,
    ],
  );

  metric(
    "wpay_settlement_execution_duration_seconds",
    "Time from automatic batch creation to on-chain execution (last 500 executed batches)",
    "summary",
    [
      ...snapshot.execution.quantiles.map(
        (entry) =>
          `wpay_settlement_execution_duration_seconds{quantile="${entry.quantile}"} ${seconds(
            entry.value,
          )}`,
      ),
      `wpay_settlement_execution_duration_seconds_sum ${seconds(snapshot.execution.sumSeconds)}`,
      `wpay_settlement_execution_duration_seconds_count ${count(snapshot.execution.count)}`,
    ],
  );

  metric(
    "wpay_settlement_reconciliation_failures",
    "Known database reconciliation inconsistencies; every value should be zero",
    "gauge",
    [
      ...RECONCILIATION_CHECKS.map(
        (check) =>
          `wpay_settlement_reconciliation_failures{check="${escapeLabel(check)}"} ${count(
            snapshot.reconciliation[check] ?? 0,
          )}`,
      ),
      `wpay_settlement_reconciliation_failures{check="total"} ${count(
        RECONCILIATION_CHECKS.reduce(
          (sum, check) => sum + (snapshot.reconciliation[check] ?? 0),
          0,
        ),
      )}`,
    ],
  );

  metric(
    "wpay_settlement_automation_enabled",
    "Configured settlement automation mode (off, prepare or execute)",
    "gauge",
    [`wpay_settlement_automation_enabled{mode="${escapeLabel(snapshot.mode)}"} 1`],
  );

  metric(
    "wpay_settlement_worker_up",
    "1 when settlement automation is enabled (prepare or execute), 0 when off",
    "gauge",
    [`wpay_settlement_worker_up ${snapshot.mode === "off" ? 0 : 1}`],
  );

  metric(
    "wpay_api_indexer_checkpoint_age_seconds",
    "Age of the newest indexer checkpoint; 0 when the indexer has never run",
    "gauge",
    [`wpay_api_indexer_checkpoint_age_seconds ${count(snapshot.indexer.lagSeconds ?? 0)}`],
  );

  metric(
    "wpay_api_indexer_up",
    "1 when the newest indexer checkpoint is at most 30 minutes old",
    "gauge",
    [
      `wpay_api_indexer_up ${
        snapshot.indexer.lagSeconds !== null && snapshot.indexer.lagSeconds <= 1_800 ? 1 : 0
      }`,
    ],
  );

  metric(
    "wpay_api_indexer_checkpoints",
    "Number of durable indexer checkpoints",
    "gauge",
    [`wpay_api_indexer_checkpoints ${count(snapshot.indexer.checkpoints)}`],
  );

  metric(
    "wpay_api_indexer_unresolved_failures",
    "Unresolved indexer dead letters",
    "gauge",
    [`wpay_api_indexer_unresolved_failures ${count(snapshot.indexer.unresolvedFailures)}`],
  );

  return `${lines.join("\n")}\n`;
}

export async function settlementMetrics(prisma: PrismaClient, config: AppConfig): Promise<string> {
  return formatSettlementMetrics(await collectSettlementMetrics(prisma, config));
}
