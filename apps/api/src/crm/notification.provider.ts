import { Injectable, Logger } from "@nestjs/common";

export type NotificationChannel = "SMS" | "WHATSAPP" | "EMAIL";

/**
 * Routing context. With it, the messaging module picks the tenant's sender,
 * template and opt-out rules; OTPs (`immediate`) are sent synchronously, all
 * else is queued and rate limited.
 */
export interface NotificationMeta {
  tenantId: string;
  outletId?: string;
  purpose: "OTP" | "CAMPAIGN" | "LOW_STOCK";
  vars?: string[]; // ordered template variables (see MESSAGING_PURPOSE_VARS)
  campaignId?: string;
  immediate?: boolean;
}

export interface NotificationProvider {
  send(channel: NotificationChannel, to: string, message: string, meta?: NotificationMeta): Promise<void>;
}

/**
 * Logs instead of sending. The live binding is the messaging module's
 * MessagingNotificationProvider (MSG91 / WhatsApp Cloud / SMTP, each falling
 * back to logging when its credentials are not configured).
 */
@Injectable()
export class LoggingNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger("Notifications");

  async send(channel: NotificationChannel, to: string, message: string): Promise<void> {
    this.logger.log(`[${channel}] → ${to}: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`);
  }
}

export const NOTIFICATION_PROVIDER = Symbol("NOTIFICATION_PROVIDER");
