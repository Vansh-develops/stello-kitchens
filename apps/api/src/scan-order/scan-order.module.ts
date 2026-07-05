import { Module } from "@nestjs/common";
import { PublicScanController, ScanValidationController } from "./scan-order.controller";
import { ScanOrderService } from "./scan-order.service";
import { OrdersModule } from "../orders/orders.module";
import { CombosModule } from "../combos/combos.module";

@Module({
  imports: [OrdersModule, CombosModule],
  controllers: [PublicScanController, ScanValidationController],
  providers: [ScanOrderService],
})
export class ScanOrderModule {}
