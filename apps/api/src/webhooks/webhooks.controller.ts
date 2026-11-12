import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateWebhookSchema, type CreateWebhookInput } from "@wpay/types";
import { WebhooksService } from "./webhooks.service";
import { CurrentUser, ZodPipe, type AuthUser } from "../common";

@ApiTags("webhooks")
@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(CreateWebhookSchema)) input: CreateWebhookInput,
  ) {
    return this.webhooks.create(user, input);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("merchantId") merchantId: string) {
    return this.webhooks.list(user, merchantId);
  }

  @Delete(":id")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<{ deleted: true }> {
    await this.webhooks.remove(user, id);
    return { deleted: true };
  }

  @Get(":id/deliveries")
  deliveries(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.webhooks.deliveries(user, id);
  }

  @Post("deliveries/:deliveryId/retry")
  retry(@CurrentUser() user: AuthUser, @Param("deliveryId") deliveryId: string) {
    return this.webhooks.retry(user, deliveryId);
  }
}

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
