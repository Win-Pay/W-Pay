import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Indexer } from "@wpay/indexer/indexer";
import { timingSafeEqual } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "./config";
import { PrismaService } from "./prisma.service";
import { Public } from "./common";
import { WebhooksModule } from "./webhooks/webhooks.controller";
import { WebhooksService } from "./webhooks/webhooks.service";

function secretMatches(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Catch-up entry point for the two long-running processes the serverless host
 * cannot keep alive: webhook delivery and Soroban event ingestion.
 *
 * A Vercel cron invokes it with `Authorization: Bearer $CRON_SECRET` (Vercel
 * only sends that header when the variable exists). Each call drains due
 * webhook deliveries and runs one indexer pass over every configured contract,
 * resuming from the durable cursor, so work missed between invocations is
 * applied in order rather than lost.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger("maintenance");

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(): Promise<Record<string, unknown>> {
    const started = Date.now();
    let delivered = 0;
    let webhookError: string | null = null;
    try {
      delivered = await this.webhooks.drain(50);
    } catch (error) {
      webhookError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook drain failed: ${webhookError}`);
    }

    let indexer: Record<string, unknown> = { skipped: true };
    try {
      const runner = new Indexer(this.prisma, {
        rpcUrl: this.config.env.STELLAR_RPC_URL ?? this.config.network.rpcUrl,
        contracts: this.config.contracts,
        startLedger: Number(process.env.INDEXER_START_LEDGER ?? 1),
        batchSize: Number(process.env.INDEXER_BATCH_SIZE ?? 100),
        logger: (message) => this.logger.log(message),
      });
      const results = await runner.runOnce();
      indexer = {
        contracts: results.length,
        fetched: results.reduce((sum, result) => sum + result.fetched, 0),
        inserted: results.reduce((sum, result) => sum + result.inserted, 0),
        applied: results.reduce((sum, result) => sum + result.applied, 0),
        failed: results.reduce((sum, result) => sum + result.failed, 0),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      indexer = { error: message };
      this.logger.warn(`indexer pass failed: ${message}`);
    }

    return {
      ok: webhookError === null && !("error" in indexer),
      webhooks: { delivered, error: webhookError },
      indexer,
      durationMs: Date.now() - started,
    };
  }
}

@Controller("internal")
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Public()
  @Get("maintenance")
  async run(@Headers("authorization") authorization: string | undefined) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new NotFoundException();
    if (!secretMatches(authorization, secret)) {
      throw new UnauthorizedException("invalid cron credential");
    }
    const result = await this.maintenance.run();
    if (!result.ok) {
      throw new HttpException({ ...result }, 502);
    }
    return result;
  }
}

@Module({
  imports: [WebhooksModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
