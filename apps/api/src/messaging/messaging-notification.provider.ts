import { Injectable, Logger } from "@nestjs/common";
import type { NotificationChannel, NotificationMeta, NotificationProvider } from "../crm/notification.provider";
import { MessagingService } from "./messaging.service";

/**
 * The live NOTIFICATION_PROVIDER binding for CRM campaigns and loyalty OTPs.
 * With routing meta it goes through the outbox (tenant templates, opt-outs, rate
 * limits, delivery status); OTPs use the tenant's preferred OTP channel and are
 * sent inline so the cashier sees a failure immediately.
 */
@Injectable()
export class MessagingNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger("Notifications");

  constructor(private readonly messaging: MessagingService) {}

  async send(channel: NotificationChannel, to: string, message: string, meta?: NotificationMeta): Promise<void> {
    if (!meta) {
      this.logger.warn(`[${channel}] → ${to}: no tenant routing, message dropped`);
      return;
    }
    const req = {
      tenantId: meta.tenantId,
      outletId: meta.outletId,
      purpose: meta.purpose,
      channel,
      to,
      body: message,
      vars: meta.vars ?? [message],
      campaignId: meta.campaignId,
    };
    if (meta.purpose === "OTP" || meta.immediate) {
      const cfg = await this.messaging.getConfig({ tenantId: meta.tenantId });
      const preferred = channel === "EMAIL" ? "EMAIL" : cfg.otpChannel === "WHATSAPP" && cfg.whatsappEnabled ? "WHATSAPP" : "SMS";
      await this.messaging.sendNow({ ...req, channel: preferred });
      return;
    }
    await this.messaging.enqueue(req);
  }
}
