import { Module } from "@nestjs/common";
import { CashController } from "./cash.controller";
import { CashService } from "./cash.service";
import { MockRazorpayGateway, PAYMENT_GATEWAY } from "./payment.gateway";

@Module({
  controllers: [CashController],
  providers: [CashService, { provide: PAYMENT_GATEWAY, useClass: MockRazorpayGateway }],
})
export class PaymentsModule {}
