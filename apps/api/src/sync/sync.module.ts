import { Module } from "@nestjs/common";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
