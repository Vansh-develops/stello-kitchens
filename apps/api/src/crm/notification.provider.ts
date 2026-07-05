import { Injectable, Logger } from "@nestjs/common";

export type NotificationChannel = "SMS" | "WHATSAPP" | "EMAIL";

export interface NotificationProvider {
  send(channel: NotificationChannel, to: string, message: string): Promise<void>;
}

/**
 * Stand-in for a real provider (MSG91 / Gupshup for SMS+WhatsApp, an ESP for email).
 * Swap this binding for a real HTTP client at integration time — the campaign code
 * depends only on the interface.
 */
@Injectable()
export class LoggingNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger("Notifications");

  async send(channel: NotificationChannel, to: string, message: string): Promise<void> {
    this.logger.log(`[${channel}] → ${to}: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`);
  }
}

export const NOTIFICATION_PROVIDER = Symbol("NOTIFICATION_PROVIDER");
