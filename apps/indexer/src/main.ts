import { createServer } from "node:http";
import { networkConfig, parseServerEnv } from "@wpay/config";
import { prisma } from "@wpay/database";
import { Indexer } from "./indexer";

/**
 * Long-running indexer with a tiny health endpoint.
 *
 * It polls Soroban RPC for events from every configured contract. The interval
 * is deliberately conservative; the checkpoint means a missed tick simply
 * catches up on the next one.
 */
async function main(): Promise<void> {
  const { env, contracts } = parseServerEnv(process.env);
  if (Object.keys(contracts).length === 0) {
    console.warn(
      "[indexer] no CONTRACT_*_ID variables are set; the indexer will idle until contracts are configured",
    );
  }
  const network = networkConfig(env.STELLAR_NETWORK);
  const indexer = new Indexer(prisma, {
    rpcUrl: env.STELLAR_RPC_URL ?? network.rpcUrl,
    contracts,
    startLedger: Number(process.env.INDEXER_START_LEDGER ?? 1),
    batchSize: Number(process.env.INDEXER_BATCH_SIZE ?? 100),
  });

  let lastRun = new Date();
  let lastError: string | null = null;
  const port = Number(process.env.INDEXER_PORT ?? 4100);
  createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: lastError ? "degraded" : "ok",
          lastRun: lastRun.toISOString(),
          lastError,
          contracts: Object.keys(contracts).length,
        }),
      );
      return;
    }
    if (request.url === "/metrics") {
      response.setHeader("content-type", "text/plain; version=0.0.4");
      response.end(
        `# TYPE wpay_indexer_last_run_timestamp_seconds gauge\nwpay_indexer_last_run_timestamp_seconds ${Math.floor(lastRun.getTime() / 1000)}\n`,
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  }).listen(port, () => console.log(`[indexer] health endpoint on :${port}/health`));

  const intervalMs = Number(process.env.INDEXER_INTERVAL_MS ?? 5_000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await indexer.runOnce();
      const inserted = results.reduce((sum, result) => sum + result.inserted, 0);
      const applied = results.reduce((sum, result) => sum + result.applied, 0);
      if (inserted > 0 || applied > 0) {
        console.log(`[indexer] inserted=${inserted} applied=${applied}`);
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[indexer] run failed: ${lastError}`);
    } finally {
      lastRun = new Date();
      running = false;
    }
  };

  // Initial pass, then a fixed interval. `unref` on shutdown handles SIGTERM.
  await tick();
  const timer = setInterval(() => void tick(), intervalMs);
  const shutdown = async () => {
    clearInterval(timer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
