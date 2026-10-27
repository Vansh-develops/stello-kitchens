import { Global, Module } from "@nestjs/common";
import { MessagingController, MessagingWebhooksController } from "./messaging.controller";
import { MessagingService } from "./messaging.service";
import { MessagingNotificationProvider } from "./messaging-notification.provider";
import { SMS_TRANSPORT, WHATSAPP_TRANSPORT, createSmsTransport, createWhatsAppTransport } from "./transports";

/**
 * Global so CRM, loyalty and low-stock alerts share one outbox/dispatcher.
 * MSG91 is live when MSG91_AUTH_KEY is set, WhatsApp Cloud when
 * WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set; otherwise each
 * channel logs instead of sending.
 */
@Global()
@Module({
  controllers: [MessagingController, MessagingWebhooksController],
  providers: [
    MessagingService,
    MessagingNotificationProvider,
    { provide: SMS_TRANSPORT, useFactory: createSmsTransport },
    { provide: WHATSAPP_TRANSPORT, useFactory: createWhatsAppTransport },
  ],
  exports: [MessagingService, MessagingNotificationProvider],
})
export class MessagingModule {}
