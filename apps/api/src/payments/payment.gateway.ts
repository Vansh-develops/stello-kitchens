import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UpiQrResult {
  upiString: string;
  ref: string;
}
export interface RefundResult {
  ref: string;
  status: string; // processed | pending | failed
}

export type CollectKind = "QR" | "LINK";
export interface CollectRequest {
  kind: CollectKind;
  amount: number; // rupees
  intentId: string; // our GatewayPayment id — echoed back in notes / reference_id
  orderRef: string;
  description: string;
  expiresAt: Date;
  customerPhone?: string;
  payeeVpa: string;
  payeeName: string;
}
export interface CollectResult {
  providerRef: string;
  imageUrl?: string | null;
  shortUrl?: string | null;
  upiString?: string | null;
  expiresAt: Date;
}
export interface CollectStatus {
  status: "PAID" | "PENDING" | "EXPIRED" | "CANCELLED";
  paymentId?: string;
  amountPaise?: number;
}

/**
 * Payment gateway seam. Razorpay (live) and a simulator implement it; settle,
 * refunds, dynamic QR collection and reconciliation depend only on the interface.
 */
export interface PaymentGateway {
  readonly name: string;
  /** True when this talks to a real provider (money really moves). */
  readonly live: boolean;
  createUpiQr(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }): UpiQrResult;
  /** `paymentId` is the captured provider payment to refund against (required when live). */
  refund(params: { amount: number; orderRef: string; reason?: string; idempotencyKey: string; paymentId?: string }): Promise<RefundResult>;
  createCollect(req: CollectRequest): Promise<CollectResult>;
  fetchCollectStatus(kind: CollectKind, providerRef: string): Promise<CollectStatus>;
  cancelCollect(kind: CollectKind, providerRef: string): Promise<void>;
  /** Recovery: find a refund previously submitted with this idempotency key, if the provider has it. */
  findRefund(paymentId: string, idempotencyKey: string): Promise<RefundResult | null>;
  /** Verify a webhook delivery against the exact raw body bytes. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENT_GATEWAY = Symbol("PAYMENT_GATEWAY");

export function hmacHexEquals(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature.trim(), "hex");
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function upiDeepLink(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }) {
  const q = new URLSearchParams({
    pa: params.payeeVpa,
    pn: params.payeeName,
    am: params.amount.toFixed(2),
    cu: "INR",
    tn: `Bill ${params.orderRef}`,
  });
  return `upi://pay?${q.toString()}`;
}

/**
 * Simulated Razorpay — the default when RAZORPAY_KEY_ID/SECRET are not set. The
 * UPI string is a real, scannable BIP-style deep link (`upi://pay?...`); a
 * collection is only marked paid through the dev "simulate payment" route or a
 * webhook signed with RAZORPAY_WEBHOOK_SECRET (dev default below).
 */
@Injectable()
export class MockRazorpayGateway implements PaymentGateway {
  readonly name = "razorpay";
  readonly live = false;
  private readonly paid = new Map<string, string>();

  createUpiQr(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }): UpiQrResult {
    return {
      upiString: upiDeepLink(params),
      ref: `rzp_qr_${params.orderRef}_${Date.now().toString(36)}`,
    };
  }

  async refund(params: { amount: number; orderRef: string; reason?: string; idempotencyKey: string }): Promise<RefundResult> {
    return { ref: `mock_rfnd_${params.idempotencyKey}`, status: "processed" };
  }

  async createCollect(req: CollectRequest): Promise<CollectResult> {
    const prefix = req.kind === "QR" ? "qr_mock_" : "plink_mock_";
    return {
      providerRef: `${prefix}${req.intentId}`,
      upiString: upiDeepLink(req),
      shortUrl: req.kind === "LINK" ? `https://rzp.io/mock/${req.intentId}` : null,
      imageUrl: null,
      expiresAt: req.expiresAt,
    };
  }

  /** Dev/test hook: mark a simulated collection as captured. */
  markPaid(providerRef: string, paymentId: string) {
    this.paid.set(providerRef, paymentId);
  }

  async fetchCollectStatus(_kind: CollectKind, providerRef: string): Promise<CollectStatus> {
    const paymentId = this.paid.get(providerRef);
    return paymentId ? { status: "PAID", paymentId } : { status: "PENDING" };
  }

  async cancelCollect(): Promise<void> {}

  async findRefund(_paymentId: string, idempotencyKey: string): Promise<RefundResult | null> {
    return { ref: `mock_rfnd_${idempotencyKey}`, status: "processed" };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (process.env.NODE_ENV === "production") return false;
    return hmacHexEquals(process.env.RAZORPAY_WEBHOOK_SECRET || "dev-razorpay-webhook-secret", rawBody, signature);
  }
}
