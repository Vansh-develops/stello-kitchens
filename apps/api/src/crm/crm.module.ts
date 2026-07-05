import { Module } from "@nestjs/common";
import { CrmController, PublicFeedbackController } from "./crm.controller";
import { CrmService } from "./crm.service";
import { LoggingNotificationProvider, NOTIFICATION_PROVIDER } from "./notification.provider";

@Module({
  controllers: [CrmController, PublicFeedbackController],
  providers: [CrmService, { provide: NOTIFICATION_PROVIDER, useClass: LoggingNotificationProvider }],
})
export class CrmModule {}
