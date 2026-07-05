import { Injectable } from "@nestjs/common";

export interface UpiQrResult {
  upiString: string;
  ref: string;
}
export interface RefundResult {
  ref: string;
  status: string;
}

/**
 * Payment gateway seam. A real Razorpay/Paytm/PhonePe client would implement this;
 * everything else (settle, refunds, dynamic QR) depends only on the interface.
 */
export interface PaymentGateway {
  readonly name: string;
  createUpiQr(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }): UpiQrResult;
  refund(params: { amount: number; orderRef: string; reason?: string }): Promise<RefundResult>;
}

export const PAYMENT_GATEWAY = Symbol("PAYMENT_GATEWAY");

/**
 * Simulated Razorpay. The UPI string is a real, scannable BIP-style deep link
 * (`upi://pay?...`) — a phone's UPI app will open it; only the capture webhook and
 * settlement are stubbed pending live credentials.
 */
@Injectable()
export class MockRazorpayGateway implements PaymentGateway {
  readonly name = "razorpay";

  createUpiQr(params: { amount: number; orderRef: string; payeeVpa: string; payeeName: string }): UpiQrResult {
    const q = new URLSearchParams({
      pa: params.payeeVpa,
      pn: params.payeeName,
      am: params.amount.toFixed(2),
      cu: "INR",
      tn: `Bill ${params.orderRef}`,
    });
    return {
      upiString: `upi://pay?${q.toString()}`,
      ref: `rzp_qr_${params.orderRef}_${Date.now().toString(36)}`,
    };
  }

  async refund(params: { amount: number; orderRef: string; reason?: string }): Promise<RefundResult> {
    // A real call would POST to /v1/payments/:id/refund and await the webhook.
    return { ref: `rzp_rfnd_${params.orderRef}_${Date.now().toString(36)}`, status: "processed" };
  }
}
