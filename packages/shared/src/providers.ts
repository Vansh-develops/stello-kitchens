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
