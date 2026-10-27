import { Module } from "@nestjs/common";
import { LoyaltyController } from "./loyalty.controller";
import { LoyaltyOtpService } from "./loyalty-otp.service";
import { NOTIFICATION_PROVIDER } from "../crm/notification.provider";
import { MessagingNotificationProvider } from "../messaging/messaging-notification.provider";

@Module({
  controllers: [LoyaltyController],
  providers: [
    LoyaltyOtpService,
    { provide: NOTIFICATION_PROVIDER, useExisting: MessagingNotificationProvider },
  ],
  exports: [LoyaltyOtpService],
})
export class LoyaltyModule {}
