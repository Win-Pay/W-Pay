import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createApp } from "./app";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("bootstrap");
  const app = await createApp();
  await app.listen(config.env.API_PORT);
  logger.log(`W-Pay API listening on ${await app.getUrl()} (docs at /v1/docs)`);
  if (!config.contracts.paymentRouter) {
    logger.warn(
      "contracts are not configured; set CONTRACT_*_ID variables after deploying to a Stellar network",
    );
  }
}

void bootstrap();
