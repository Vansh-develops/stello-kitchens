import { Module } from "@nestjs/common";
import { CrmController, PublicFeedbackController } from "./crm.controller";
import { CrmService } from "./crm.service";
import { NOTIFICATION_PROVIDER } from "./notification.provider";
import { MessagingNotificationProvider } from "../messaging/messaging-notification.provider";

@Module({
  controllers: [CrmController, PublicFeedbackController],
  providers: [CrmService, { provide: NOTIFICATION_PROVIDER, useExisting: MessagingNotificationProvider }],
  exports: [NOTIFICATION_PROVIDER],
})
export class CrmModule {}
