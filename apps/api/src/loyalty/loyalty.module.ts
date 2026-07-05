import { Module } from "@nestjs/common";
import { LoyaltyController } from "./loyalty.controller";
import { LoyaltyOtpService } from "./loyalty-otp.service";
import { NOTIFICATION_PROVIDER, LoggingNotificationProvider } from "../crm/notification.provider";

@Module({
  controllers: [LoyaltyController],
  providers: [
    LoyaltyOtpService,
    { provide: NOTIFICATION_PROVIDER, useClass: LoggingNotificationProvider },
  ],
  exports: [LoyaltyOtpService],
})
export class LoyaltyModule {}
