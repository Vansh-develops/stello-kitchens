import { Module } from "@nestjs/common";
import { CashController } from "./cash.controller";
import { CashService } from "./cash.service";
import { MockRazorpayGateway, PAYMENT_GATEWAY, type PaymentGateway } from "./payment.gateway";
import { RazorpayGateway, razorpayConfigFromEnv } from "./razorpay.gateway";

/** Live Razorpay when RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are set; otherwise the simulator. */
export function createPaymentGateway(): PaymentGateway {
  const cfg = razorpayConfigFromEnv();
  return cfg ? new RazorpayGateway(cfg) : new MockRazorpayGateway();
}

@Module({
  controllers: [CashController],
  providers: [CashService, { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway }],
  exports: [PAYMENT_GATEWAY, CashService],
})
export class PaymentsModule {}
