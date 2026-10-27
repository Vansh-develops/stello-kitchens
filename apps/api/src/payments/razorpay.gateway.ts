import { Injectable } from "@nestjs/common";
import { toPaise } from "@stello/shared";
import { httpJson, ProviderHttpError, toMsisdn } from "../integrations/http";
import {
  hmacHexEquals,
  type CollectKind,
  type CollectRequest,
  type CollectResult,
  type CollectStatus,
  type PaymentGateway,
  type RefundResult,
  type UpiQrResult,
} from "./payment.gateway";

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl: string;
}

export function razorpayConfigFromEnv(env = process.env): RazorpayConfig | null {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "",
    baseUrl: env.RAZORPAY_BASE_URL ?? "https://api.razorpay.com",
  };
}

type RzpQr = { id: string; image_url?: string; close_by?: number; status: string };
type RzpLink = { id: string; short_url?: string; expire_by?: number; status: string; payments?: { payment_id: string; status: string; amount: number }[] | null };
type RzpPayment = { id: string; status: string; amount: number };
type RzpRefund = { id: string; status: string; receipt?: string | null; amount: number };

/**
 * Live Razorpay client (REST v1, HTTP Basic key_id:key_secret). Implements:
 *  - UPI QR Codes API (`POST /v1/payments/qr_codes`, single_use + fixed_amount)
 *  - Payment Links API (`POST /v1/payment_links`, reference_id = our intent id)
 *  - Refunds (`POST /v1/payments/:id/refund`) with `receipt` = our persisted
 *    refund id. Razorpay rejects a reused receipt on the same payment, so a retry
 *    can never refund twice; recovery finds the refund again by that receipt.
 * Amounts cross this boundary in integer paise.
 */
@Injectable()
export class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay";
  readonly live = true;

  constructor(private readonly cfg: RazorpayConfig) {}

  private auth() {
    return { Authorization: `Basic ${Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64")}` };
  }

  private call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    return httpJson<T>("razorpay", `${this.cfg.baseUrl}${path}`, { method, headers: this.auth(), body }).then((r) => r.body);
  }

  /** Static UPI intent (unchanged behaviour of the plain "Show UPI QR" button). */
  createUpiQr(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }): UpiQrResult {
    const q = new URLSearchParams({ pa: params.payeeVpa, pn: params.payeeName, am: params.amount.toFixed(2), cu: "INR", tn: `Bill ${params.orderRef}` });
    return { upiString: `upi://pay?${q.toString()}`, ref: `upi_${params.orderRef}_${Date.now().toString(36)}` };
  }

  async createCollect(req: CollectRequest): Promise<CollectResult> {
    const notes = { intent_id: req.intentId, bill: req.orderRef };
    if (req.kind === "QR") {
      const qr = await this.call<RzpQr>("POST", "/v1/payments/qr_codes", {
        type: "upi_qr",
        name: req.payeeName.slice(0, 40),
        usage: "single_use",
        fixed_amount: true,
        payment_amount: toPaise(req.amount),
        description: req.description.slice(0, 200),
        close_by: Math.floor(req.expiresAt.getTime() / 1000),
        notes,
      });
      return { providerRef: qr.id, imageUrl: qr.image_url ?? null, expiresAt: qr.close_by ? new Date(qr.close_by * 1000) : req.expiresAt };
    }
    const link = await this.call<RzpLink>("POST", "/v1/payment_links", {
      amount: toPaise(req.amount),
      currency: "INR",
      accept_partial: false,
      reference_id: req.intentId,
      description: req.description.slice(0, 200),
      expire_by: Math.floor(req.expiresAt.getTime() / 1000),
      upi_link: true,
      ...(req.customerPhone ? { customer: { contact: `+${toMsisdn(req.customerPhone)}` }, notify: { sms: true, email: false } } : {}),
      reminder_enable: false,
      notes,
    });
    return { providerRef: link.id, shortUrl: link.short_url ?? null, expiresAt: link.expire_by ? new Date(link.expire_by * 1000) : req.expiresAt };
  }

  async fetchCollectStatus(kind: CollectKind, providerRef: string): Promise<CollectStatus> {
    if (kind === "QR") {
      const [qr, payments] = await Promise.all([
        this.call<RzpQr>("GET", `/v1/payments/qr_codes/${encodeURIComponent(providerRef)}`),
        this.call<{ items: RzpPayment[] }>("GET", `/v1/payments/qr_codes/${encodeURIComponent(providerRef)}/payments`),
      ]);
      const captured = payments.items.find((p) => p.status === "captured");
      if (captured) return { status: "PAID", paymentId: captured.id, amountPaise: captured.amount };
      return { status: qr.status === "closed" ? "EXPIRED" : "PENDING" };
    }
    const link = await this.call<RzpLink>("GET", `/v1/payment_links/${encodeURIComponent(providerRef)}`);
    const captured = (link.payments ?? []).find((p) => p.status === "captured");
    if (link.status === "paid" && captured) return { status: "PAID", paymentId: captured.payment_id, amountPaise: captured.amount };
    if (link.status === "expired") return { status: "EXPIRED" };
    if (link.status === "cancelled") return { status: "CANCELLED" };
    return { status: "PENDING" };
  }

  async cancelCollect(kind: CollectKind, providerRef: string): Promise<void> {
    const path = kind === "QR" ? `/v1/payments/qr_codes/${encodeURIComponent(providerRef)}/close` : `/v1/payment_links/${encodeURIComponent(providerRef)}/cancel`;
    await this.call("POST", path);
  }

  async refund(params: { amount: number; orderRef: string; reason?: string; idempotencyKey: string; paymentId?: string }): Promise<RefundResult> {
    if (!params.paymentId) throw new ProviderHttpError("razorpay", 400, "no captured Razorpay payment to refund against");
    try {
      const r = await this.call<RzpRefund>("POST", `/v1/payments/${encodeURIComponent(params.paymentId)}/refund`, {
        amount: toPaise(params.amount),
        speed: "normal",
        receipt: params.idempotencyKey,
        notes: { refund_id: params.idempotencyKey, bill: params.orderRef, ...(params.reason ? { reason: params.reason.slice(0, 200) } : {}) },
      });
      return { ref: r.id, status: r.status };
    } catch (e) {
      // A 4xx for a receipt we already used means an earlier attempt reached
      // Razorpay: return that refund instead of failing the operation.
      if (e instanceof ProviderHttpError && e.status !== null && e.status < 500) {
        const existing = await this.findRefund(params.paymentId, params.idempotencyKey).catch(() => null);
        if (existing) return existing;
      }
      throw e;
    }
  }

  async findRefund(paymentId: string, idempotencyKey: string): Promise<RefundResult | null> {
    const list = await this.call<{ items: RzpRefund[] }>("GET", `/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    const hit = list.items.find((r) => r.receipt === idempotencyKey);
    return hit ? { ref: hit.id, status: hit.status } : null;
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!this.cfg.webhookSecret) return false;
    return hmacHexEquals(this.cfg.webhookSecret, rawBody, signature);
  }
}
