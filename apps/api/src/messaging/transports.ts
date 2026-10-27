import { Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { hmacHexEquals } from "../payments/payment.gateway";
import { httpJson, ProviderHttpError, toMsisdn } from "../integrations/http";

export interface SendResult {
  provider: string;
  messageId: string;
}

/** SMS (India, DLT-regulated). OTP and transactional/promotional templates only. */
export interface SmsTransport {
  readonly name: string;
  readonly live: boolean;
  sendOtp(p: { to: string; otp: string; templateId?: string; expiryMinutes?: number }): Promise<SendResult>;
  sendTemplate(p: { to: string; templateId: string; vars: Record<string, string>; senderId?: string }): Promise<SendResult>;
}

/** WhatsApp Business (template messages — the only kind allowed outside a 24h session). */
export interface WhatsAppTransport {
  readonly name: string;
  readonly live: boolean;
  sendTemplate(p: {
    to: string;
    phoneNumberId?: string;
    template: string;
    language: string;
    bodyParams: string[];
    /** Authentication (OTP) templates carry the code again in their copy-code / URL button. */
    buttonParam?: string;
  }): Promise<SendResult>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}

const logId = () => `log_${randomBytes(6).toString("hex")}`;

/** Default SMS transport: logs instead of sending (dev/tests, or no MSG91 credentials). */
export class LoggingSmsTransport implements SmsTransport {
  readonly name = "log";
  readonly live = false;
  private readonly logger = new Logger("SMS");
  async sendOtp(p: { to: string; otp: string }) {
    this.logger.log(`[otp] → ${p.to}: ${p.otp}`);
    return { provider: this.name, messageId: logId() };
  }
  async sendTemplate(p: { to: string; templateId: string; vars: Record<string, string> }) {
    this.logger.log(`[${p.templateId}] → ${p.to}: ${JSON.stringify(p.vars).slice(0, 80)}`);
    return { provider: this.name, messageId: logId() };
  }
}

export class LoggingWhatsAppTransport implements WhatsAppTransport {
  readonly name = "log";
  readonly live = false;
  private readonly logger = new Logger("WhatsApp");
  async sendTemplate(p: { to: string; template: string; bodyParams: string[] }) {
    this.logger.log(`[${p.template}] → ${p.to}: ${p.bodyParams.join(" | ").slice(0, 80)}`);
    return { provider: this.name, messageId: logId() };
  }
  verifyWebhook(rawBody: Buffer, sig: string | undefined) {
    if (process.env.NODE_ENV === "production") return false;
    return hmacHexEquals(process.env.WHATSAPP_APP_SECRET || "dev-whatsapp-app-secret", rawBody, sig?.replace(/^sha256=/, ""));
  }
}

// ---------- MSG91 ----------

export interface Msg91Config {
  authKey: string;
  baseUrl: string;
  otpTemplateId?: string;
  senderId?: string;
}

export function msg91ConfigFromEnv(env = process.env): Msg91Config | null {
  if (!env.MSG91_AUTH_KEY) return null;
  return {
    authKey: env.MSG91_AUTH_KEY,
    baseUrl: env.MSG91_BASE_URL ?? "https://control.msg91.com",
    otpTemplateId: env.MSG91_OTP_TEMPLATE_ID || undefined,
    senderId: env.MSG91_SENDER_ID || undefined,
  };
}

/**
 * MSG91 v5. OTP: `POST /api/v5/otp` with our own generated code (`otp` param),
 * so verification stays in our database and the settle transaction. Other SMS:
 * the Flow API (`POST /api/v5/flow`) with the MSG91 template id; that template
 * is linked to its DLT template id inside MSG91, which is what lets operators
 * deliver it in India. MSG91 answers 200 with `type: "error"` on failures.
 */
export class Msg91SmsTransport implements SmsTransport {
  readonly name = "msg91";
  readonly live = true;
  constructor(private readonly cfg: Msg91Config) {}

  private check(body: { type?: string; message?: string; request_id?: string }) {
    if (body?.type !== "success") throw new ProviderHttpError("msg91", 400, `rejected: ${body?.message ?? "unknown error"}`, body);
    return { provider: this.name, messageId: String(body.request_id ?? body.message ?? "") };
  }

  async sendOtp(p: { to: string; otp: string; templateId?: string; expiryMinutes?: number }) {
    const templateId = p.templateId ?? this.cfg.otpTemplateId;
    if (!templateId) throw new ProviderHttpError("msg91", 400, "no OTP template configured (MSG91_OTP_TEMPLATE_ID)");
    const { body } = await httpJson<{ type?: string; message?: string; request_id?: string }>("msg91", `${this.cfg.baseUrl}/api/v5/otp`, {
      method: "POST",
      headers: { authkey: this.cfg.authKey },
      query: { template_id: templateId, mobile: toMsisdn(p.to), otp: p.otp, otp_expiry: p.expiryMinutes ?? 5 },
      body: {},
    });
    return this.check(body);
  }

  async sendTemplate(p: { to: string; templateId: string; vars: Record<string, string>; senderId?: string }) {
    const sender = p.senderId ?? this.cfg.senderId;
    const { body } = await httpJson<{ type?: string; message?: string }>("msg91", `${this.cfg.baseUrl}/api/v5/flow`, {
      method: "POST",
      headers: { authkey: this.cfg.authKey },
      body: {
        template_id: p.templateId,
        ...(sender ? { sender } : {}),
        short_url: "0",
        recipients: [{ mobiles: toMsisdn(p.to), ...p.vars }],
      },
    });
    return this.check(body);
  }
}

// ---------- Meta WhatsApp Cloud API ----------

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  graphUrl: string;
}

export function whatsappConfigFromEnv(env = process.env): WhatsAppConfig | null {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return null;
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    appSecret: env.WHATSAPP_APP_SECRET ?? "",
    graphUrl: `${env.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com"}/${env.WHATSAPP_GRAPH_VERSION ?? "v21.0"}`,
  };
}

/**
 * WhatsApp Cloud API: `POST /{phone-number-id}/messages` with a pre-approved
 * template. Webhooks are signed with X-Hub-Signature-256 = sha256=HMAC(app secret, raw body).
 */
export class WhatsAppCloudTransport implements WhatsAppTransport {
  readonly name = "whatsapp";
  readonly live = true;
  constructor(private readonly cfg: WhatsAppConfig) {}

  async sendTemplate(p: { to: string; phoneNumberId?: string; template: string; language: string; bodyParams: string[]; buttonParam?: string }) {
    const components: unknown[] = [];
    if (p.bodyParams.length) components.push({ type: "body", parameters: p.bodyParams.map((text) => ({ type: "text", text })) });
    if (p.buttonParam) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: p.buttonParam }] });
    const { body } = await httpJson<{ messages?: { id: string }[] }>(
      "whatsapp",
      `${this.cfg.graphUrl}/${encodeURIComponent(p.phoneNumberId ?? this.cfg.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toMsisdn(p.to),
          type: "template",
          template: { name: p.template, language: { code: p.language }, ...(components.length ? { components } : {}) },
        },
      },
    );
    const id = body?.messages?.[0]?.id;
    if (!id) throw new ProviderHttpError("whatsapp", 502, "no message id in response", body);
    return { provider: this.name, messageId: id };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined) {
    if (!this.cfg.appSecret || !signatureHeader?.startsWith("sha256=")) return false;
    return hmacHexEquals(this.cfg.appSecret, rawBody, signatureHeader.slice(7));
  }
}

export const SMS_TRANSPORT = Symbol("SMS_TRANSPORT");
export const WHATSAPP_TRANSPORT = Symbol("WHATSAPP_TRANSPORT");

export function createSmsTransport(): SmsTransport {
  const cfg = msg91ConfigFromEnv();
  return cfg ? new Msg91SmsTransport(cfg) : new LoggingSmsTransport();
}
export function createWhatsAppTransport(): WhatsAppTransport {
  const cfg = whatsappConfigFromEnv();
  return cfg ? new WhatsAppCloudTransport(cfg) : new LoggingWhatsAppTransport();
}
