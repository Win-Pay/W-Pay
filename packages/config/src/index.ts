/**
 * Environment-independent configuration plus validated server env parsing.
 *
 * Nothing here reads `process.env` at import time: the same module is bundled
 * into the browser apps, where `process` may not exist.
 */
import { z } from "zod";

export type StellarNetwork = "futurenet" | "testnet" | "mainnet";

export interface NetworkConfig {
  name: StellarNetwork;
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  explorerUrl: string;
  friendbotUrl: string | null;
}

export const NETWORKS: Record<StellarNetwork, NetworkConfig> = {
  futurenet: {
    name: "futurenet",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    explorerUrl: "https://stellar.expert/explorer/futurenet",
    friendbotUrl: "https://friendbot-futurenet.stellar.org",
  },
  testnet: {
    name: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    explorerUrl: "https://stellar.expert/explorer/testnet",
    friendbotUrl: "https://friendbot.stellar.org",
  },
  mainnet: {
    name: "mainnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://soroban-rpc.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    explorerUrl: "https://stellar.expert/explorer/public",
    friendbotUrl: null,
  },
};

export function networkConfig(name: string | undefined): NetworkConfig {
  const key = (name ?? "testnet") as StellarNetwork;
  const config = NETWORKS[key];
  if (!config) {
    throw new Error(`unknown STELLAR_NETWORK "${name}" (expected futurenet, testnet or mainnet)`);
  }
  return config;
}

/** Names of every contract, matching the crate names without the prefix. */
export const CONTRACT_NAMES = [
  "paymentRouter",
  "invoiceManager",
  "escrowManager",
  "refundManager",
  "subscriptionManager",
  "settlementManager",
  "merchantRegistry",
  "treasuryVault",
  "feeManager",
  "configurationManager",
  "emergencyPause",
  "roleManager",
  "upgradeManager",
  "priceOracle",
  "governance",
  "impactNft",
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];
export type ContractIds = Partial<Record<ContractName, string>>;

/** Env var name for a contract, e.g. paymentRouter -> CONTRACT_PAYMENT_ROUTER_ID. */
export function contractEnvVar(name: ContractName): string {
  const snake = name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  return `CONTRACT_${snake}_ID`;
}

export function contractsFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ContractIds {
  const ids: ContractIds = {};
  for (const name of CONTRACT_NAMES) {
    const value = env[contractEnvVar(name)];
    if (value) ids[name] = value;
  }
  return ids;
}

export function requireContract(ids: ContractIds, name: ContractName): string {
  const id = ids[name];
  if (!id) {
    throw new Error(
      `contract ${name} is not configured; set ${contractEnvVar(name)} after deploying it`,
    );
  }
  return id;
}

const address = z.string().regex(/^[GC][A-Z2-7]{55}$/);

export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("1h"),
  STELLAR_NETWORK: z.enum(["futurenet", "testnet", "mainnet"]).default("testnet"),
  STELLAR_RPC_URL: z.string().url().optional(),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  SOROBAN_SOURCE_SECRET: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  /** Enables the shared rate-limit counters; unset means in-process counters. */
  REDIS_URL: z.string().url().optional(),
  ADMIN_ADDRESSES: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function parseServerEnv(env: NodeJS.ProcessEnv): {
  env: ServerEnv;
  contracts: ContractIds;
  adminAddresses: string[];
} {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  const adminAddresses = parsed.data.ADMIN_ADDRESSES.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const candidate of adminAddresses) {
    if (!address.safeParse(candidate).success) {
      throw new Error(`ADMIN_ADDRESSES contains an invalid address: ${candidate}`);
    }
  }
  return { env: parsed.data, contracts: contractsFromEnv(env), adminAddresses };
}

/** Fee in stroops for `amount` at `bps`, rounded down (matches FeeManager). */
export function feeFor(amount: bigint, bps: number): bigint {
  if (bps < 0 || bps > 1000) throw new Error("fee bps must be between 0 and 1000");
  if (amount < 0n) throw new Error("amount must not be negative");
  return (amount * BigInt(bps)) / 10_000n;
}

export function splitAmount(amount: bigint, bps: number): { fee: bigint; net: bigint } {
  const fee = feeFor(amount, bps);
  return { fee, net: amount - fee };
}

/** Converts a human decimal string ("12.5") into stroops for 7-decimal assets. */
export function toStroops(value: string, decimals = 7): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal asset`);
  }
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(whole + padded);
}

export function fromStroops(value: bigint, decimals = 7): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Idempotency / cursor helpers shared by the API and SDK. */
export const DEFAULT_PAGE_SIZE = 20;

export function clampPageSize(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
