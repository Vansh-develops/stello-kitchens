import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { BillingController } from "./billing.controller";
import { BillingSettingsService } from "./billing-settings.service";
import { OrderOpsService } from "./order-ops.service";
import { ParkedService } from "./parked.service";

@Module({
  imports: [OrdersModule],
  controllers: [BillingController],
  providers: [BillingSettingsService, OrderOpsService, ParkedService],
  exports: [BillingSettingsService],
})
export class BillingModule {}
