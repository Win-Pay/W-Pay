import { networkConfig, parseServerEnv, type ContractIds, type NetworkConfig, type ServerEnv } from "@wpay/config";

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  env: ServerEnv;
  contracts: ContractIds;
  adminAddresses: string[];
  network: NetworkConfig;
  sorobanSourceSecret?: string;
}

/** Parses and validates the environment once, at bootstrap. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const { env, contracts, adminAddresses } = parseServerEnv(source);
  const network = networkConfig(env.STELLAR_NETWORK);
  return {
    env: {
      ...env,
      STELLAR_RPC_URL: env.STELLAR_RPC_URL ?? network.rpcUrl,
      STELLAR_HORIZON_URL: env.STELLAR_HORIZON_URL ?? network.horizonUrl,
    },
    contracts,
    adminAddresses,
    network,
    sorobanSourceSecret: env.SOROBAN_SOURCE_SECRET,
  };
}
