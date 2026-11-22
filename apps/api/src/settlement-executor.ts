import type { xdr } from "@stellar/stellar-sdk";
import { calls, scv, type WalletSigner } from "@wpay/sdk";
import type { SorobanService } from "./soroban.service";

export type OnChainSettlementStatus = "OPEN" | "CLOSED" | "EXECUTED" | "CANCELLED";

export interface SettlementExecutionWindow {
  id: string;
  token: string;
  periodStart: Date;
  periodEnd: Date;
  windowIdOnChain: bigint | null;
  entries: { payee: string; amount: bigint }[];
}

export interface SettlementExecutionResult {
  windowIdOnChain: bigint;
  status: OnChainSettlementStatus;
  txHashes: string[];
  entriesOnChain: number;
}

/**
 * The worker never assumes an on-chain step happened. `execute` is resumable:
 * it reads the contract window first, adds only missing entries, then closes
 * and executes while its transaction budget allows. A crash between two
 * transactions therefore cannot duplicate an entry or a payout.
 */
export interface SettlementExecutor {
  readonly available: boolean;
  execute(window: SettlementExecutionWindow): Promise<SettlementExecutionResult>;
}

export class SettlementExecutionError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "SettlementExecutionError";
  }
}

interface RawWindow {
  token?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  entries?: unknown;
  status?: unknown;
  executed_at?: unknown;
}

const STATUS_BY_INDEX: OnChainSettlementStatus[] = ["OPEN", "CLOSED", "EXECUTED", "CANCELLED"];

/** Decodes the unit-variant enum the SDK returns in any of its shapes. */
export function normalizeSettlementStatus(value: unknown): OnChainSettlementStatus | null {
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (upper.includes("EXECUTED")) return "EXECUTED";
    if (upper.includes("CANCELLED") || upper.includes("CANCELED")) return "CANCELLED";
    if (upper.includes("CLOSED")) return "CLOSED";
    if (upper.includes("OPEN")) return "OPEN";
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return STATUS_BY_INDEX[value] ?? null;
  }
  if (typeof value === "bigint") {
    return STATUS_BY_INDEX[Number(value)] ?? null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const status = normalizeSettlementStatus(entry);
      if (status) return status;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["tag", "name", "value", "status"]) {
      const status = normalizeSettlementStatus(record[key]);
      if (status) return status;
    }
  }
  return null;
}

export function parseWindowId(value: unknown): bigint | null {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["id", "window_id", "value"]) {
      const parsed = parseWindowId(record[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function toAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["amount", "value"]) {
      const parsed = toAmount(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

export interface OnChainEntry {
  payee: string;
  amount: bigint;
}

export function parseOnChainEntries(value: unknown): OnChainEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: OnChainEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const payee = typeof record.payee === "string" ? record.payee : null;
    const amount = toAmount(record.amount);
    if (!payee || amount === null) return null;
    entries.push({ payee, amount });
  }
  return entries;
}

export interface OnChainWindow {
  windowId: bigint;
  token: string | null;
  status: OnChainSettlementStatus | null;
  executed: boolean;
  entries: OnChainEntry[];
}

/**
 * Signs settlement transactions with the dedicated operator key. The key is
 * deliberately separate from SOROBAN_SOURCE_SECRET's intended contract roles:
 * it must be granted Operator on SettlementManager, nothing more.
 */
export class SorobanSettlementExecutor implements SettlementExecutor {
  private readonly signer: WalletSigner | null;

  constructor(
    private readonly soroban: SorobanService,
    private readonly maxSteps = 5,
  ) {
    this.signer = soroban.operatorSigner();
  }

  get available(): boolean {
    return Boolean(this.signer && this.soroban.has("settlementManager"));
  }

  async execute(window: SettlementExecutionWindow): Promise<SettlementExecutionResult> {
    const signer = this.signer;
    if (!signer || !this.soroban.has("settlementManager")) {
      throw new SettlementExecutionError("settlement operator signer is not configured", false);
    }

    const txHashes: string[] = [];
    let steps = 0;
    let windowId = window.windowIdOnChain;
    let status: OnChainSettlementStatus | null = null;
    let entriesOnChain = 0;

    if (windowId === null) {
      if (steps >= this.maxSteps) {
        throw new SettlementExecutionError("transaction budget exhausted before opening the window");
      }
      const opened = await this.runCall(
        signer,
        calls.openSettlementWindow({
          operator: signer.publicKey,
          token: window.token,
          periodStart: Math.floor(window.periodStart.getTime() / 1000),
          periodEnd: Math.floor(window.periodEnd.getTime() / 1000),
        }),
      );
      txHashes.push(opened.hash);
      steps += 1;
      windowId = parseWindowId(opened.returnValue);
      if (windowId === null) {
        throw new SettlementExecutionError(
          `open_window succeeded (${opened.hash}) but returned an unreadable id; ` +
            "link the window manually before retrying",
          false,
        );
      }
      status = "OPEN";
    }

    const localByPayee = new Map<string, bigint>();
    for (const entry of window.entries) {
      if (localByPayee.has(entry.payee)) {
        throw new SettlementExecutionError(`duplicate payee ${entry.payee} in local batch`, false);
      }
      localByPayee.set(entry.payee, entry.amount);
    }

    let snapshot = await this.readWindow(windowId);
    if (snapshot.token !== null && snapshot.token !== window.token) {
      throw new SettlementExecutionError(
        `on-chain window ${windowId} uses token ${snapshot.token}, expected ${window.token}`,
        false,
      );
    }
    entriesOnChain = snapshot.entries.length;

    for (const entry of snapshot.entries) {
      const expected = localByPayee.get(entry.payee);
      if (expected === undefined) {
        throw new SettlementExecutionError(
          `on-chain window ${windowId} contains payee ${entry.payee} that is not in the local batch`,
          false,
        );
      }
      if (expected !== entry.amount) {
        throw new SettlementExecutionError(
          `on-chain entry for ${entry.payee} is ${entry.amount}, local batch has ${expected}`,
          false,
        );
      }
    }
    if (snapshot.entries.length > localByPayee.size) {
      throw new SettlementExecutionError(
        `on-chain window ${windowId} has more entries than the local batch`,
        false,
      );
    }

    if (snapshot.status === "EXECUTED") {
      return { windowIdOnChain: windowId, status: "EXECUTED", txHashes, entriesOnChain };
    }
    if (snapshot.status === "CANCELLED") {
      throw new SettlementExecutionError(`on-chain window ${windowId} was cancelled`, false);
    }
    if (snapshot.status === null) {
      // A fresh window is known to be open because open_window succeeded above.
      // For a pre-linked window we refuse to mutate without a readable state.
      if (window.windowIdOnChain !== null) {
        throw new SettlementExecutionError(
          `on-chain status of window ${windowId} could not be decoded; operator review required`,
          false,
        );
      }
      status = "OPEN";
    } else {
      status = snapshot.status;
    }

    if (status === "CLOSED" && steps < this.maxSteps) {
      if (snapshot.entries.length !== localByPayee.size) {
        throw new SettlementExecutionError(
          `on-chain window ${windowId} is closed with ${snapshot.entries.length} entries but the local batch has ${localByPayee.size}`,
          false,
        );
      }
      const executed = await this.runCall(
        signer,
        calls.executeSettlementWindow(signer.publicKey, windowId),
      );
      txHashes.push(executed.hash);
      steps += 1;
      status = "EXECUTED";
    }

    if (status === "OPEN") {
      const onChainPayees = new Set(snapshot.entries.map((entry) => entry.payee));
      for (const entry of window.entries) {
        if (steps >= this.maxSteps) break;
        if (onChainPayees.has(entry.payee)) continue;
        const added = await this.runCall(
          signer,
          calls.addSettlementEntry({
            operator: signer.publicKey,
            windowId,
            payee: entry.payee,
            amount: entry.amount,
          }),
        );
        txHashes.push(added.hash);
        steps += 1;
        entriesOnChain += 1;
      }

      if (steps < this.maxSteps) {
        snapshot = await this.readWindow(windowId);
        entriesOnChain = snapshot.entries.length;
        if (snapshot.status === "EXECUTED") {
          return { windowIdOnChain: windowId, status: "EXECUTED", txHashes, entriesOnChain };
        }
        if (snapshot.entries.length === localByPayee.size) {
          const closed = await this.runCall(
            signer,
            calls.closeSettlementWindow(signer.publicKey, windowId),
          );
          txHashes.push(closed.hash);
          steps += 1;
          status = "CLOSED";
          if (steps < this.maxSteps) {
            const executed = await this.runCall(
              signer,
              calls.executeSettlementWindow(signer.publicKey, windowId),
            );
            txHashes.push(executed.hash);
            status = "EXECUTED";
          }
        }
      }
    }

    return { windowIdOnChain: windowId, status: status ?? "OPEN", txHashes, entriesOnChain };
  }

  private async readWindow(windowId: bigint): Promise<OnChainWindow> {
    const signer = this.signer;
    if (!signer) throw new SettlementExecutionError("operator signer is not configured", false);
    const raw = await this.soroban.gateway.read<RawWindow>({
      contract: "settlementManager",
      method: "get_window",
      args: [scv.u64(windowId)],
      source: signer.publicKey,
    });
    if (!raw || typeof raw !== "object") {
      throw new SettlementExecutionError(`window ${windowId} returned no state`, false);
    }
    const entries = parseOnChainEntries(raw.entries);
    if (entries === null) {
      throw new SettlementExecutionError(
        `window ${windowId} entries could not be decoded; operator review required`,
        false,
      );
    }
    return {
      windowId,
      token: typeof raw.token === "string" ? raw.token : null,
      status: normalizeSettlementStatus(raw.status),
      executed: raw.executed_at !== null && raw.executed_at !== undefined,
      entries,
    };
  }

  private async runCall(
    signer: WalletSigner,
    call: { method: string; args: xdr.ScVal[] },
  ): Promise<{ hash: string; returnValue: unknown }> {
    const transaction = await this.soroban.gateway.prepareInvocation({
      contract: "settlementManager",
      method: call.method,
      args: call.args,
      source: signer.publicKey,
    });
    const signed = await signer.signTransaction(transaction.toXDR(), {
      networkPassphrase: this.soroban.gateway.networkPassphrase,
    });
    const submitted = await this.soroban.gateway.submit(signed.signedTxXdr);
    const outcome = await this.soroban.gateway.awaitTransaction(submitted.hash, 60_000);
    if (outcome.status !== "SUCCESS") {
      throw new SettlementExecutionError(
        `settlementManager.${call.method} ended as ${outcome.status} (${submitted.hash})`,
        true,
      );
    }
    return { hash: outcome.hash, returnValue: outcome.returnValue };
  }
}
