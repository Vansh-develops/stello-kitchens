import { Injectable, Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingCycle } from "@stello/shared";

/**
 * Payment-collection seam for Stello's OWN subscription billing (tenants paying
 * Stello). Deliberately separate from payments/payment.gateway.ts, which is for
 * restaurant bills. The billing service depends only on this interface.
 */
export interface SaasBillingProvider {
  readonly name: string;
  /** Start a recurring subscription. A checkout URL means the customer must authorise the mandate first. */
  createSubscription(p: {
    tenantId: string;
    planCode: string;
    providerPlanId: string | null;
    cycle: BillingCycle;
    customerName: string;
    customerEmail: string;
  }): Promise<{ providerSubscriptionId: string; checkoutUrl: string | null; chargesImmediately: boolean }>;
  changePlan(providerSubscriptionId: string, providerPlanId: string | null): Promise<void>;
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void>;
  /** Collect one invoice now (first charge, mock renewals, manual retry). */
  chargeInvoice(p: {
    invoiceNumber: string;
    amount: number; // paise incl. GST
    providerSubscriptionId: string | null;
  }): Promise<{ status: "PAID" | "FAILED" | "PENDING"; providerRef: string | null }>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(body: unknown, eventId: string | undefined): BillingWebhookEvent | null;
}

export interface BillingWebhookEvent {
  eventId: string;
  type: "ACTIVATED" | "CHARGED" | "PAYMENT_FAILED" | "HALTED" | "CANCELLED";
  providerSubscriptionId: string;
  paymentId: string | null;
  amount: number | null; // paise
  periodStart: Date | null;
  periodEnd: Date | null;
}

export const SAAS_BILLING_PROVIDER = Symbol("SAAS_BILLING_PROVIDER");

/**
 * Default provider for dev/tests: every subscription activates at once and every
 * charge succeeds — unless SAAS_BILLING_MOCK_FAIL=1 (or `failCharges` is set by a
 * test), which makes charges fail so the PAST_DUE → SUSPENDED path can be exercised.
 */
@Injectable()
export class MockSaasBillingProvider implements SaasBillingProvider {
  readonly name = "mock";
  failCharges = process.env.SAAS_BILLING_MOCK_FAIL === "1";

  async createSubscription(p: { tenantId: string }) {
    return { providerSubscriptionId: `mock_sub_${p.tenantId}_${Date.now().toString(36)}`, checkoutUrl: null, chargesImmediately: true };
  }

  async changePlan(): Promise<void> {}

  async cancelSubscription(): Promise<void> {}

  async chargeInvoice(p: { invoiceNumber: string }) {
    if (this.failCharges) return { status: "FAILED" as const, providerRef: null };
    return { status: "PAID" as const, providerRef: `mock_pay_${p.invoiceNumber.replace(/\W/g, "")}` };
  }

  verifyWebhook(): boolean {
    return false; // the mock never receives webhooks
  }

  parseWebhook(): BillingWebhookEvent | null {
    return null;
  }
}

/**
 * Razorpay Subscriptions (https://razorpay.com/docs/api/payments/subscriptions/).
 * Razorpay owns the recurring schedule: we create the subscription, send the tenant
 * to its hosted `short_url` to authorise the mandate, and learn about charges,
 * failures and halts from signed webhooks.
 */
export class RazorpaySubscriptionsProvider implements SaasBillingProvider {
  readonly name = "razorpay";
  private readonly logger = new Logger("RazorpaySubscriptions");
  private readonly base = "https://api.razorpay.com/v1";

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json?.error?.description ?? `Razorpay ${method} ${path} failed (${res.status})`;
      this.logger.warn(msg);
      throw new Error(msg);
    }
    return json as T;
  }

  async createSubscription(p: {
    tenantId: string;
    planCode: string;
    providerPlanId: string | null;
    cycle: BillingCycle;
    customerEmail: string;
  }) {
    if (!p.providerPlanId) throw new Error(`Plan ${p.planCode} (${p.cycle}) has no Razorpay plan id configured`);
    const sub = await this.call<{ id: string; short_url?: string }>("POST", "/subscriptions", {
      plan_id: p.providerPlanId,
      // Razorpay requires a finite count: 10 years of cycles.
      total_count: p.cycle === "YEARLY" ? 10 : 120,
      customer_notify: 1,
      notes: { tenantId: p.tenantId, planCode: p.planCode, email: p.customerEmail },
    });
    return { providerSubscriptionId: sub.id, checkoutUrl: sub.short_url ?? null, chargesImmediately: false };
  }

  async changePlan(providerSubscriptionId: string, providerPlanId: string | null): Promise<void> {
    if (!providerPlanId) throw new Error("Target plan has no Razorpay plan id configured");
    await this.call("PATCH", `/subscriptions/${providerSubscriptionId}`, {
      plan_id: providerPlanId,
      schedule_change_at: "now",
      customer_notify: 1,
    });
  }

  async cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<void> {
    await this.call("POST", `/subscriptions/${providerSubscriptionId}/cancel`, {
      cancel_at_cycle_end: atPeriodEnd ? 1 : 0,
    });
  }

  async chargeInvoice() {
    // Razorpay retries mandate charges on its own schedule; there is no
    // merchant-initiated charge for a subscription. The outcome arrives by webhook.
    return { status: "PENDING" as const, providerRef: null };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature || !this.webhookSecret) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown, eventId: string | undefined): BillingWebhookEvent | null {
    const b = body as {
      event?: string;
      payload?: {
        subscription?: { entity?: { id?: string; current_start?: number; current_end?: number } };
        payment?: { entity?: { id?: string; amount?: number } };
      };
    };
    const map: Record<string, BillingWebhookEvent["type"]> = {
      "subscription.activated": "ACTIVATED",
      "subscription.charged": "CHARGED",
      "subscription.pending": "PAYMENT_FAILED",
      "subscription.halted": "HALTED",
      "subscription.cancelled": "CANCELLED",
      "subscription.completed": "CANCELLED",
    };
    const type = b?.event ? map[b.event] : undefined;
    const sub = b?.payload?.subscription?.entity;
    if (!type || !sub?.id) return null;
    const pay = b.payload?.payment?.entity;
    const ts = (n?: number) => (typeof n === "number" ? new Date(n * 1000) : null);
    return {
      eventId: eventId ?? `${b.event}:${sub.id}:${pay?.id ?? sub.current_start ?? ""}`,
      type,
      providerSubscriptionId: sub.id,
      paymentId: pay?.id ?? null,
      amount: typeof pay?.amount === "number" ? pay.amount : null,
      periodStart: ts(sub.current_start),
      periodEnd: ts(sub.current_end),
    };
  }
}

/** Real adapter when its credentials are configured; the mock otherwise. */
export function saasBillingProviderFactory(): SaasBillingProvider {
  const keyId = process.env.SAAS_BILLING_RAZORPAY_KEY_ID;
  const keySecret = process.env.SAAS_BILLING_RAZORPAY_KEY_SECRET;
  if (keyId && keySecret) {
    return new RazorpaySubscriptionsProvider(keyId, keySecret, process.env.SAAS_BILLING_RAZORPAY_WEBHOOK_SECRET ?? "");
  }
  return new MockSaasBillingProvider();
}
