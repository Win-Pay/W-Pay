import { networkConfig, parseServerEnv, type ContractIds, type NetworkConfig, type ServerEnv } from "@wpay/config";

export const APP_CONFIG = Symbol("APP_CONFIG");

export type CookieSameSite = "lax" | "strict" | "none";

export interface CookieConfig {
  secure: boolean;
  sameSite: CookieSameSite;
  domain?: string;
}

export interface AppConfig {
  env: ServerEnv;
  contracts: ContractIds;
  adminAddresses: string[];
  network: NetworkConfig;
  cookies: CookieConfig;
  sorobanSourceSecret?: string;
}

const PLACEHOLDER_HOSTS = ["example.com", "example", "configuration-required.invalid"];

function assertPublicHttps(name: string, value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https in production`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    PLACEHOLDER_HOSTS.some((placeholder) => host === placeholder || host.endsWith(`.${placeholder}`))
  ) {
    throw new Error(`${name} must be a real public hostname in production`);
  }
}

/**
 * Production fails closed instead of silently degrading. A missing Redis URL,
 * placeholder hostnames or a development JWT secret stop the process at boot.
 */
export function assertProductionConfig(env: ServerEnv): void {
  if (env.NODE_ENV !== "production") return;
  assertPublicHttps("API_PUBLIC_URL", env.API_PUBLIC_URL);
  assertPublicHttps("WEB_PUBLIC_URL", env.WEB_PUBLIC_URL);
  for (const origin of (env.CORS_ORIGINS ?? "").split(",")) {
    const trimmed = origin.trim();
    if (trimmed) assertPublicHttps("CORS_ORIGINS", trimmed);
  }
  if (/replace-with|changeme|change-me|your-jwt|example/i.test(env.JWT_SECRET)) {
    throw new Error("JWT_SECRET still contains a placeholder value");
  }
  if (!env.REDIS_URL && env.ALLOW_IN_MEMORY_RATE_LIMIT !== "1") {
    throw new Error(
      "REDIS_URL is required in production for shared rate limiting; set ALLOW_IN_MEMORY_RATE_LIMIT=1 only for a deliberate single-replica deployment",
    );
  }
}

/** Parses and validates the environment once, at bootstrap. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const { env, contracts, adminAddresses } = parseServerEnv(source);
  assertProductionConfig(env);
  const network = networkConfig(env.STELLAR_NETWORK);
  const sameSite: CookieSameSite =
    env.REFRESH_COOKIE_SAMESITE ?? (env.NODE_ENV === "production" ? "none" : "lax");
  return {
    env: {
      ...env,
      STELLAR_RPC_URL: env.STELLAR_RPC_URL ?? network.rpcUrl,
      STELLAR_HORIZON_URL: env.STELLAR_HORIZON_URL ?? network.horizonUrl,
    },
    contracts,
    adminAddresses,
    network,
    cookies: {
      secure: env.NODE_ENV === "production" || sameSite === "none",
      sameSite,
      domain: env.COOKIE_DOMAIN,
    },
    sorobanSourceSecret: env.SOROBAN_SOURCE_SECRET,
  };
}
