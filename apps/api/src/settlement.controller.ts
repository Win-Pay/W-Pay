import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { UserRole } from "@wpay/types";
import { CurrentUser, Roles, ZodPipe, type AuthUser } from "./common";
import { SettlementAutomationService } from "./settlement.service";

const RunSchema = z.object({
  execute: z.boolean().optional(),
  force: z.boolean().optional(),
});

const TokenSchema = z.string().regex(/^C[A-Z2-7]{55}$|^native$/);

@ApiTags("settlements")
@Controller("admin/settlements")
export class SettlementAutomationController {
  constructor(private readonly settlement: SettlementAutomationService) {}

  /** Manual trigger for the same worker the cron runs. */
  @Roles("OPERATOR" as UserRole)
  @Post("run")
  run(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(RunSchema)) body: { execute?: boolean; force?: boolean },
  ) {
    if (body.execute && user.role !== "ADMIN") {
      throw new ForbiddenException("only an ADMIN may trigger signed settlement execution");
    }
    return this.settlement.run(body);
  }

  @Roles("OPERATOR" as UserRole)
  @Get("automation")
  automation(@Query("limit") limit?: string) {
    return this.settlement.automationStatus(Number(limit ?? 50));
  }

  @Roles("OPERATOR" as UserRole)
  @Get("reconciliation")
  reconciliation(
    @CurrentUser() user: AuthUser,
    @Query("merchantId") merchantId?: string,
    @Query("token") token?: string,
  ) {
    if (token && !TokenSchema.safeParse(token).success) {
      throw new BadRequestException("token must be a contract id or native");
    }
    return this.settlement.reconciliation(user, { merchantId, token });
  }

  /** Clears the backoff after an operator has investigated a failed batch. */
  @Roles("ADMIN")
  @Post(":id/retry")
  retry(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.settlement.retryBatch(user, id);
  }
}

@Module({
  controllers: [SettlementAutomationController],
  providers: [SettlementAutomationService],
  exports: [SettlementAutomationService],
})
export class SettlementModule {}
