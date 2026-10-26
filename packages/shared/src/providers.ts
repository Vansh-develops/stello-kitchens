import { z } from "zod";

// ---------- Gateway collection (Razorpay UPI QR / payment link) ----------

export const GatewayCollectSchema = z.object({
  amount: z.number().positive().multipleOf(0.01).optional(), // defaults to the order total
  kind: z.enum(["QR", "LINK"]).optional(),
  customerPhone: z.string().regex(/^\+?\d{10,13}$/).optional(), // link mode: Razorpay SMSes the link
});
export type GatewayCollectInput = z.infer<typeof GatewayCollectSchema>;

export type GatewayPaymentStatus = "CREATED" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";

export interface GatewayPaymentDto {
  id: string;
  orderId: string;
  kind: "QR" | "LINK";
  amount: number;
  status: GatewayPaymentStatus;
  providerRef: string | null;
  paymentId: string | null;
  imageUrl: string | null;
  shortUrl: string | null;
  upiString: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  live: boolean; // false = simulator (no real money moves)
}

/** Realtime `payment:changed` event, emitted to the outlet room. */
export interface PaymentChangedEvent {
  outletId: string;
  orderId: string;
  intentId: string;
  status: GatewayPaymentStatus;
  amount: number;
}

export interface UnresolvedRefundDto {
  id: string;
  orderId: string;
  amount: number;
  mode: string;
  status: string; // PENDING | UNKNOWN | MANUAL
  gatewayRef: string | null;
  createdAt: string;
  reconciledAt: string | null;
}

// ---------- Messaging (MSG91 SMS, WhatsApp Cloud, email) ----------

export const MessagingChannelEnum = z.enum(["SMS", "WHATSAPP", "EMAIL"]);
export type MessagingChannel = z.infer<typeof MessagingChannelEnum>;
export const MessagingPurposeEnum = z.enum(["OTP", "CAMPAIGN", "LOW_STOCK"]);
export type MessagingPurpose = z.infer<typeof MessagingPurposeEnum>;

/**
 * Ordered variables each purpose supplies. SMS templates receive them as
 * var1..varN (or the configured varNames); WhatsApp templates as body {{1}}..{{N}}.
 */
export const MESSAGING_PURPOSE_VARS: Record<MessagingPurpose, string[]> = {
  OTP: ["otp"],
  CAMPAIGN: ["message"],
  LOW_STOCK: ["material", "stock", "reorderLevel", "outlet"],
};

export const SmsTemplateSchema = z.object({
  templateId: z.string().trim().min(1).max(64), // MSG91 template id
  dltTemplateId: z.string().trim().regex(/^\d{10,25}$/, "DLT template ids are numeric").optional(),
  varNames: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
});
export const WhatsAppTemplateSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Use the approved template name (lowercase, underscores)"),
  language: z.string().trim().min(2).max(10).default("en"),
});
export const PurposeTemplatesSchema = z.object({
  sms: SmsTemplateSchema.optional(),
  whatsapp: WhatsAppTemplateSchema.optional(),
});
export type PurposeTemplates = z.infer<typeof PurposeTemplatesSchema>;

export const LowStockRecipientSchema = z.object({
  name: z.string().trim().min(1).max(60),
  phone: z.string().trim().regex(/^\+?\d{10,13}$/).optional(),
  email: z.string().trim().email().optional(),
  channels: z.array(MessagingChannelEnum).min(1),
});
export type LowStockRecipient = z.infer<typeof LowStockRecipientSchema>;

export const MessagingConfigSchema = z.object({
  smsEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  smsSenderId: z.string().trim().regex(/^[A-Z0-9]{6}$/, "DLT sender id is 6 characters").nullable().optional(),
  whatsappPhoneNumberId: z.string().trim().regex(/^\d{5,25}$/).nullable().optional(),
  otpChannel: z.enum(["SMS", "WHATSAPP"]),
  templates: z.object({ OTP: PurposeTemplatesSchema.optional(), CAMPAIGN: PurposeTemplatesSchema.optional(), LOW_STOCK: PurposeTemplatesSchema.optional() }),
  ratePerMinute: z.number().int().min(1).max(6000),
  lowStockEnabled: z.boolean(),
  lowStockRecipients: z.array(LowStockRecipientSchema).max(20),
});
export type MessagingConfigInput = z.infer<typeof MessagingConfigSchema>;

export interface MessagingConfigDto extends MessagingConfigInput {
  /** Which transport is live per channel ("log" = not configured; messages are only logged). */
  transports: { sms: string; whatsapp: string; email: string };
}

export const OptOutSchema = z.object({
  phone: z.string().trim().regex(/^\+?\d{10,13}$/),
  channel: z.enum(["SMS", "WHATSAPP", "EMAIL", "ALL"]),
});
export type OptOutInput = z.infer<typeof OptOutSchema>;

export interface OptOutDto {
  id: string;
  phone: string;
  channel: string;
  source: string;
  createdAt: string;
}

export type OutboxStatus = "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED";

export interface OutboxMessageDto {
  id: string;
  purpose: MessagingPurpose;
  channel: MessagingChannel;
  recipient: string;
  status: OutboxStatus;
  provider: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export type CampaignStatsDto = Record<OutboxStatus, number> & { total: number };

export const TestMessageSchema = z.object({
  channel: MessagingChannelEnum,
  purpose: MessagingPurposeEnum.default("CAMPAIGN"),
  to: z.string().trim().min(5).max(120),
});
export type TestMessageInput = z.infer<typeof TestMessageSchema>;

/** Last 10 digits — the national form used for opt-outs and customer matching. */
export function nationalPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

// ---------- GST e-invoicing (GSP) ----------

export const EInvoiceProfileSchema = z.object({
  legalName: z.string().trim().min(3).max(100),
  tradeName: z.string().trim().max(100).nullable().optional(),
  address1: z.string().trim().min(3).max(100),
  address2: z.string().trim().max(100).nullable().optional(),
  location: z.string().trim().min(3).max(50),
  pincode: z.number().int().min(100000).max(999999),
  stateCode: z.string().trim().regex(/^\d{2}$/, "Two-digit GST state code"),
  phone: z.string().trim().regex(/^\d{6,12}$/).nullable().optional(),
  email: z.string().trim().email().nullable().optional(),
});
export type EInvoiceProfileInput = z.infer<typeof EInvoiceProfileSchema>;
export interface EInvoiceProfileDto extends EInvoiceProfileInput {
  gstin: string | null;
  provider: string; // "masters-india" | "mock-gsp"
  live: boolean;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GenerateIrnSchema = z.object({
  buyerGstin: z.string().trim().toUpperCase().regex(GSTIN_RE, "Invalid GSTIN").optional(),
  // Overrides when the GSTIN master lookup lacks an address.
  buyer: z
    .object({
      legalName: z.string().trim().min(3).max(100).optional(),
      address1: z.string().trim().min(3).max(100).optional(),
      location: z.string().trim().min(3).max(50).optional(),
      pincode: z.number().int().min(100000).max(999999).optional(),
    })
    .optional(),
});
export type GenerateIrnInput = z.infer<typeof GenerateIrnSchema>;

export const CancelIrnSchema = z.object({
  reason: z.string().trim().min(3).max(100).default("Cancelled by merchant"),
  reasonCode: z.enum(["1", "2", "3", "4"]).default("4"), // 1 duplicate · 2 data entry mistake · 3 order cancelled · 4 others
});
export type CancelIrnInput = z.infer<typeof CancelIrnSchema>;

export const EwayBillByIrnSchema = z.object({
  distanceKm: z.number().int().min(0).max(4000),
  transporterId: z.string().trim().regex(GSTIN_RE).optional(),
  transporterName: z.string().trim().max(100).optional(),
  vehicleNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,15}$/).optional(),
});
export type EwayBillByIrnInput = z.infer<typeof EwayBillByIrnSchema>;

/** The IRP accepts cancellation only within 24 hours of the acknowledgement. */
export const IRN_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
