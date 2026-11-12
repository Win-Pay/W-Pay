/**
 * Vercel serverless entrypoint. Nest is initialised once per warm function
 * instance; the underlying Express instance handles each request.
 */
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../src/app";

let appPromise: Promise<INestApplication> | undefined;

async function getHandler(): Promise<(req: IncomingMessage, res: ServerResponse) => void> {
  if (!appPromise) {
    appPromise = createApp({ swagger: false }).then(async (app) => {
      await app.init();
      return app;
    });
  }
  const app = await appPromise;
  return app.getHttpAdapter().getInstance() as (req: IncomingMessage, res: ServerResponse) => void;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const handle = await getHandler();
  handle(req, res);
}
