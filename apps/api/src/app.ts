import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { AllExceptionsFilter } from "./filters";
import { serializeBigInts } from "./common";

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

/**
 * Builds the Nest application without listening. Shared by the long-running
 * server (`main.ts`) and the Vercel serverless entrypoint.
 */
export async function createApp(options: { swagger?: boolean } = {}): Promise<INestApplication> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  const configuredOrigins = [
    config.env.WEB_PUBLIC_URL,
    config.env.API_PUBLIC_URL,
    ...(config.env.CORS_ORIGINS?.split(",") ?? []),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeOrigin);
  // Localhost is a development convenience only; a production deployment must
  // list every browser origin explicitly.
  const developmentOrigins =
    config.env.NODE_ENV === "production"
      ? []
      : ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"];
  const allowedOrigins = new Set([...configuredOrigins, ...developmentOrigins]);
  app.enableCors({
    origin: [...allowedOrigins],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-api-key",
      "x-csrf-token",
      "idempotency-key",
      "x-request-id",
    ],
    maxAge: 86_400,
  });

  // Behind Caddy or a cloud load balancer, request.ip must be the client
  // address or every rate-limit bucket collapses onto the proxy.
  const trustProxy = config.env.TRUST_PROXY || (config.env.NODE_ENV === "production" ? 1 : 0);
  if (trustProxy > 0) {
    (app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set(
      "trust proxy",
      trustProxy,
    );
  }

  // CORS prevents reading a cross-origin response, but browsers still send the
  // request. Reject state-changing requests from unlisted origins outright,
  // including form-style requests that bypass CORS preflight.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      next();
      return;
    }
    const origin = request.header("origin");
    if (origin && !allowedOrigins.has(normalizeOrigin(origin))) {
      response.status(403).json({
        statusCode: 403,
        code: "ORIGIN_FORBIDDEN",
        message: "request origin is not allowed",
      });
      return;
    }
    next();
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
