import { Injectable, Logger } from "@nestjs/common";
export const EMAIL_PROVIDER = "EMAIL_PROVIDER";
export interface EmailProvider {
  sendVerification(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
  sendInvite(to: string, link: string, restaurantName: string): Promise<void>;
  /** Scheduled report emails (optional so other providers keep compiling). */
  sendReport?(to: string[], subject: string, text: string, attachments: EmailAttachment[]): Promise<void>;
}
export interface EmailAttachment { filename: string; contentType: string; content: Buffer }
/** Dev/default: logs the link. Swap for a real vendor by binding EMAIL_PROVIDER. */
@Injectable()
export class LoggingEmailProvider implements EmailProvider {
  private readonly log = new Logger("Email");
  async sendVerification(to: string, link: string) { this.log.log(`[verify] ${to} -> ${link}`); }
  async sendPasswordReset(to: string, link: string) { this.log.log(`[reset] ${to} -> ${link}`); }
  async sendInvite(to: string, link: string, r: string) { this.log.log(`[invite:${r}] ${to} -> ${link}`); }
  async sendReport(to: string[], subject: string, _text: string, attachments: EmailAttachment[]) {
    this.log.log(`[report] ${to.join(", ")} -> ${subject} (${attachments.map((a) => `${a.filename} ${a.content.length}B`).join(", ")})`);
  }
}
