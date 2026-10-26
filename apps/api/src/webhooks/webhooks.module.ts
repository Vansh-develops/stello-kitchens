import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { LowStockWatcher } from "./low-stock.watcher";

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, LowStockWatcher],
  exports: [WebhooksService],
})
export class WebhooksModule {}
