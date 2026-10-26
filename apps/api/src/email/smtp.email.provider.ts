import { Injectable } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import type { EmailProvider } from "./email.provider";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function smtpConfigFromEnv(env = process.env): SmtpConfig | null {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM ?? "Stello Kitchens <no-reply@stellotechs.com>",
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * SMTP delivery via nodemailer — works with any ESP's SMTP relay (SES, SendGrid,
 * Postmark, Zoho, Google Workspace). Account emails carry a plain-text part and a
 * minimal HTML part with the action link.
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;

  constructor(private readonly cfg: SmtpConfig, transport?: Transporter) {
    this.transport =
      transport ??
      createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      });
  }

  private async mail(to: string, subject: string, text: string, link?: { href: string; label: string }) {
    const html = link
      ? `<p>${esc(text).replace(/\n/g, "<br>")}</p><p><a href="${esc(link.href)}">${esc(link.label)}</a></p>`
      : `<p>${esc(text).replace(/\n/g, "<br>")}</p>`;
    const info = await this.transport.sendMail({ from: this.cfg.from, to, subject, text: link ? `${text}\n\n${link.href}` : text, html });
    return String(info.messageId ?? "");
  }

  async sendVerification(to: string, link: string) {
    await this.mail(to, "Verify your Stello Kitchens email", "Confirm your email address to finish creating your restaurant account.", { href: link, label: "Verify email" });
  }
  async sendPasswordReset(to: string, link: string) {
    await this.mail(to, "Reset your Stello Kitchens password", "Someone asked to reset your password. If it was you, use the link below; otherwise ignore this email.", { href: link, label: "Reset password" });
  }
  async sendInvite(to: string, link: string, restaurantName: string) {
    await this.mail(to, `You're invited to ${restaurantName} on Stello Kitchens`, `${restaurantName} has invited you to join their team on Stello Kitchens.`, { href: link, label: "Accept invite" });
  }
  send(to: string, subject: string, text: string) {
    return this.mail(to, subject, text);
  }
}
