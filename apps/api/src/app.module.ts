import { Global, MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { APP_CONFIG, loadConfig, type AppConfig } from "./config";
import { PrismaService } from "./prisma.service";
import { AuditService } from "./audit.service";
import { SorobanService } from "./soroban.service";
import {
  AuthGuard,
  RateLimitGuard,
  RequestLogger,
  RolesGuard,
} from "./common";
import { AuthModule } from "./modules/auth";
import { MerchantsModule } from "./modules/merchants";
import { PaymentsModule } from "./modules/payments";
import { InvoicesModule } from "./modules/invoices";
import { OperationsModule } from "./modules/operations";
import { PlatformModule } from "./modules/platform";
import { WebhooksModule } from "./webhooks/webhooks.controller";
import { MaintenanceModule } from "./maintenance";

const config = loadConfig();

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useValue: config satisfies AppConfig },
    PrismaService,
    AuditService,
    SorobanService,
  ],
  exports: [APP_CONFIG, PrismaService, AuditService, SorobanService],
})
export class CoreModule {}

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: config.env.JWT_SECRET,
      signOptions: { algorithm: "HS256" },
    }),
    CoreModule,
    AuthModule,
    MerchantsModule,
    PaymentsModule,
    InvoicesModule,
    OperationsModule,
    PlatformModule,
    WebhooksModule,
    MaintenanceModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogger).forRoutes("*");
  }
}
