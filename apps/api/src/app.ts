import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { AllExceptionsFilter } from "./filters";
import { serializeBigInts } from "./common";

/**
 * Builds the Nest application without listening. Shared by the long-running
 * server (`main.ts`) and the Vercel serverless entrypoint.
 */
export async function createApp(options: { swagger?: boolean } = {}): Promise<INestApplication> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  app.enableCors({
    origin: [
      config.env.WEB_PUBLIC_URL,
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
    ],
    credentials: true,
  });
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (options.swagger !== false) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("W-Pay API")
      .setDescription(
        "Stellar/Soroban payment gateway API: merchants, payments, invoices, escrow, refunds, " +
          "subscriptions, settlements, treasury and webhooks. Amounts are i128 stroop strings.",
      )
      .setVersion("0.1.0")
      .addBearerAuth()
      .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "api-key")
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    // BigInt cannot be JSON-serialized into the OpenAPI document.
    SwaggerModule.setup("docs", app, serializeBigInts(document));
  }

  return app;
}
