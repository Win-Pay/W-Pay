/**
 * Soroban gateway: builds contract invocations, submits signed transactions and
 * reads contract state through simulation. No transaction is ever simulated as
 * if it succeeded — `submit` returns exactly what the network reported.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { ContractIds, ContractName } from "@wpay/config";
import { requireContract } from "@wpay/config";

export interface SorobanGatewayConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: ContractIds;
}

export interface InvocationRequest {
  contract: ContractName;
  method: string;
  args?: xdr.ScVal[];
  source: string;
  fee?: string;
  timeoutSecs?: number;
}

export interface SubmitResult {
  hash: string;
  status: string;
  latestLedger?: number;
}

export type TransactionOutcome =
  | { status: "SUCCESS"; hash: string; ledger: number; returnValue: unknown }
  | { status: "FAILED"; hash: string; ledger?: number; error?: string }
  | { status: "NOT_FOUND"; hash: string };

export class SorobanGateway {
  readonly server: rpc.Server;
  readonly networkPassphrase: string;
  private readonly contracts: ContractIds;
  private readonly rpcUrl: string;

  constructor(config: SorobanGatewayConfig) {
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase;
    this.contracts = config.contracts;
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  }

  get url(): string {
    return this.rpcUrl;
  }

  contractId(name: ContractName): string {
    return requireContract(this.contracts, name);
  }

  hasContract(name: ContractName): boolean {
    return Boolean(this.contracts[name]);
  }

  contract(name: ContractName): Contract {
    return new Contract(this.contractId(name));
  }

  /** Builds (but does not simulate) an invocation with the source account's seq. */
  async buildInvocation(request: InvocationRequest): Promise<Transaction> {
    const account = await this.server.getAccount(request.source);
    return new TransactionBuilder(account, {
      fee: request.fee ?? BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract(request.contract).call(request.method, ...(request.args ?? [])))
      .setTimeout(request.timeoutSecs ?? 60)
      .build();
  }

  /** Builds and simulates, returning a transaction ready for signature. */
  async prepareInvocation(request: InvocationRequest): Promise<Transaction> {
    const transaction = await this.buildInvocation(request);
    const prepared = await this.server.prepareTransaction(transaction);
    return prepared as Transaction;
  }

  async submit(signedXdr: string): Promise<SubmitResult> {
    const transaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
    const response = await this.server.sendTransaction(transaction);
    if (response.status === "ERROR") {
      throw new Error(`transaction rejected: ${JSON.stringify(response.errorResult ?? response.status)}`);
    }
    return {
      hash: response.hash,
      status: response.status,
      latestLedger: response.latestLedger,
    };
  }

  /** Polls until the transaction is final, or the timeout elapses. */
  async awaitTransaction(hash: string, timeoutMs = 30_000): Promise<TransactionOutcome> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.server.getTransaction(hash);
      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          status: "SUCCESS",
          hash,
          ledger: response.ledger,
          returnValue: response.returnValue ? scValToNative(response.returnValue) : undefined,
        };
      }
      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        return { status: "FAILED", hash, ledger: response.ledger };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { status: "NOT_FOUND", hash };
  }

  /** Simulates a read-only call and decodes its return value. */
  async read<T>(request: Omit<InvocationRequest, "fee">): Promise<T> {
    const transaction = await this.buildInvocation(request);
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`simulation failed: ${simulation.error}`);
    }
    if (!simulation.result) {
      throw new Error("simulation returned no value");
    }
    return scValToNative(simulation.result.retval) as T;
  }
}

/** ScVal constructors, kept in one place so argument types stay consistent. */
export const scv = {
  address: (value: string): xdr.ScVal => new Address(value).toScVal(),
  i128: (value: bigint | string): xdr.ScVal => nativeToScVal(BigInt(value), { type: "i128" }),
  u64: (value: bigint | string | number): xdr.ScVal => nativeToScVal(BigInt(value), { type: "u64" }),
  u32: (value: number): xdr.ScVal => nativeToScVal(value, { type: "u32" }),
  symbol: (value: string): xdr.ScVal => nativeToScVal(value, { type: "symbol" }),
  string: (value: string): xdr.ScVal => nativeToScVal(value, { type: "string" }),
  bool: (value: boolean): xdr.ScVal => nativeToScVal(value),
  bytes32: (hex: string): xdr.ScVal => {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("bytes32 must be 32 hex-encoded bytes");
    return nativeToScVal(Buffer.from(clean, "hex"), { type: "bytes" });
  },
  none: (): xdr.ScVal => xdr.ScVal.scvVoid(),
};
