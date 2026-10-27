import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { GatewayPaymentsController, RazorpayWebhookController } from "./gateway-payments.controller";
import { GatewayPaymentsService } from "./gateway-payments.service";

@Module({
  imports: [PaymentsModule],
  controllers: [GatewayPaymentsController, RazorpayWebhookController],
  providers: [GatewayPaymentsService],
  exports: [GatewayPaymentsService],
})
export class GatewayPaymentsModule {}
