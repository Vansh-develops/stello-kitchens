import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { CashService } from "../src/payments/cash.service";
import { MockRazorpayGateway } from "../src/payments/payment.gateway";
import { RazorpayGateway } from "../src/payments/razorpay.gateway";
import { GatewayPaymentsService } from "../src/gateway-payments/gateway-payments.service";
import { capture, mockHttp, providerFixture, realtimeStub, type Captured } from "./providers-fixture";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

const RZP = "https://api.razorpay.com";
const cfg = { keyId: "rzp_test_key", keySecret: "rzp_test_secret", webhookSecret: "whsec_test", baseUrl: RZP };
const sign = (body: string, secret = cfg.webhookSecret) => createHmac("sha256", secret).update(body).digest("hex");

let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
});
afterEach(() => http.restore());

async function setup(gateway: RazorpayGateway | MockRazorpayGateway) {
  const f = await providerFixture(prisma);
  const rt = realtimeStub();
  const orders = new OrdersService(prisma, rt.gateway as any, { verifyAndConsume: vi.fn() } as any);
  const cash = new CashService(prisma, gateway);
  const svc = new GatewayPaymentsService(prisma, rt.gateway as any, gateway);
  const order = await orders.create(f.user, { outletId: f.outlet.id, orderType: "TAKEAWAY", items: [{ itemId: f.item.id, quantity: 1, addonIds: [] }], combos: [] });
  return { ...f, rt, orders, cash, svc, order };
}

describe("RazorpayGateway request shape", () => {
  it("creates a single-use fixed-amount UPI QR with Basic auth, paise and the intent id in notes", async () => {
    const calls: Captured[] = [];
    http.agent.get(RZP).intercept({ path: "/v1/payments/qr_codes", method: "POST" })
      .reply(capture(calls, { id: "qr_123", image_url: "https://rzp.io/qr/123.png", close_by: 1900000000, status: "active" }));
    const gw = new RazorpayGateway(cfg);
    const res = await gw.createCollect({
      kind: "QR", amount: 105.5, intentId: "gp_1", orderRef: "B-7", description: "Outlet bill B-7",
      expiresAt: new Date(1_900_000_000_000), payeeVpa: "x@upi", payeeName: "Outlet",
    });
    expect(res.providerRef).toBe("qr_123");
    expect(res.imageUrl).toContain("qr/123");
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("rzp_test_key:rzp_test_secret").toString("base64")}`);
    expect(calls[0].body).toMatchObject({
      type: "upi_qr", usage: "single_use", fixed_amount: true, payment_amount: 10550, close_by: 1_900_000_000,
      notes: { intent_id: "gp_1", bill: "B-7" },
    });
  });

  it("creates a payment link keyed by reference_id", async () => {
    const calls: Captured[] = [];
    http.agent.get(RZP).intercept({ path: "/v1/payment_links", method: "POST" })
      .reply(capture(calls, { id: "plink_9", short_url: "https://rzp.io/i/abc", status: "created" }));
    const res = await new RazorpayGateway(cfg).createCollect({
      kind: "LINK", amount: 20, intentId: "gp_2", orderRef: "B-1", description: "d", expiresAt: new Date(1_900_000_000_000),
      customerPhone: "9876543210", payeeVpa: "x@upi", payeeName: "Outlet",
    });
    expect(res.shortUrl).toBe("https://rzp.io/i/abc");
    expect(calls[0].body).toMatchObject({ amount: 2000, currency: "INR", reference_id: "gp_2", upi_link: true, customer: { contact: "+919876543210" } });
  });

  it("refunds with the persisted refund id as receipt and recovers an earlier refund on a duplicate receipt", async () => {
    const calls: Captured[] = [];
    const pool = http.agent.get(RZP);
    pool.intercept({ path: "/v1/payments/pay_1/refund", method: "POST" })
      .reply(capture(calls, { error: { code: "BAD_REQUEST_ERROR", description: "receipt already exists" } }, 400));
    pool.intercept({ path: "/v1/payments/pay_1/refunds?count=100", method: "GET" })
      .reply(capture(calls, { items: [{ id: "rfnd_A", status: "processed", receipt: "refund_42", amount: 5000 }] }));
    const res = await new RazorpayGateway(cfg).refund({ amount: 50, orderRef: "B-1", idempotencyKey: "refund_42", paymentId: "pay_1" });
    expect(res).toEqual({ ref: "rfnd_A", status: "processed" });
    expect(calls[0].body).toMatchObject({ amount: 5000, receipt: "refund_42", speed: "normal" });
  });

  it("verifies webhook signatures against the raw body only", () => {
    const gw = new RazorpayGateway(cfg);
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(gw.verifyWebhook(body, sign(body.toString()))).toBe(true);
    expect(gw.verifyWebhook(Buffer.from('{"event": "payment.captured"}'), sign(body.toString()))).toBe(false);
    expect(gw.verifyWebhook(body, undefined)).toBe(false);
    expect(new RazorpayGateway({ ...cfg, webhookSecret: "" }).verifyWebhook(body, sign(body.toString(), ""))).toBe(false);
  });
});

describe("collection + webhook reconciliation", () => {
  it("marks a QR paid once from a signed qr_code.credited webhook, ignores replays and emits realtime", async () => {
    const s = await setup(new MockRazorpayGateway());
    const intent = await s.svc.createCollect(s.user, s.outlet.id, s.order.id, {});
    expect(intent).toMatchObject({ status: "CREATED", amount: 105, kind: "QR", live: false });
    expect(intent.upiString).toContain("pa=outlet%40okhdfc");

    const body = JSON.stringify({
      event: "qr_code.credited",
      payload: {
        payment: { entity: { id: "pay_QR1", status: "captured", amount: 10500, notes: [] } },
        qr_code: { entity: { id: intent.providerRef, notes: { intent_id: intent.id } } },
      },
    });
    const secret = "dev-razorpay-webhook-secret";
    await expect(s.svc.handleRazorpayWebhook(Buffer.from(body), sign(body, "wrong"), "evt_1")).rejects.toThrow("Invalid webhook signature");
    const first = await s.svc.handleRazorpayWebhook(Buffer.from(body), sign(body, secret), "evt_1");
    expect(first).toMatchObject({ duplicate: false, outcome: "paid" });
    const replay = await s.svc.handleRazorpayWebhook(Buffer.from(body), sign(body, secret), "evt_1");
    expect(replay).toMatchObject({ duplicate: true });

    const saved = await prisma.gatewayPayment.findUniqueOrThrow({ where: { id: intent.id } });
    expect(saved).toMatchObject({ status: "PAID", paymentId: "pay_QR1" });
    expect(s.rt.emit).toHaveBeenCalledWith("payment:changed", expect.objectContaining({ intentId: intent.id, status: "PAID" }));
    expect(await prisma.auditLog.count({ where: { action: "GATEWAY_PAYMENT_CAPTURED", entityId: intent.id } })).toBe(1);
  });

  it("refuses to collect more than the bill and rejects a mismatched capture amount", async () => {
    const s = await setup(new MockRazorpayGateway());
    await expect(s.svc.createCollect(s.user, s.outlet.id, s.order.id, { amount: 106 })).rejects.toThrow("exceeds");
    const intent = await s.svc.createCollect(s.user, s.outlet.id, s.order.id, { amount: 50 });
    expect(await s.svc.markPaid(intent.id, "pay_x", 4000, "test")).toBe("mismatch");
    expect((await prisma.gatewayPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe("CREATED");
  });
});

describe("refunds through live Razorpay", () => {
  async function paidOrder() {
    const s = await setup(new RazorpayGateway(cfg));
    const pool = http.agent.get(RZP);
    pool.intercept({ path: "/v1/payments/qr_codes", method: "POST" }).reply(200, { id: "qr_L1", status: "active", close_by: 1_900_000_000 });
    const intent = await s.svc.createCollect(s.user, s.outlet.id, s.order.id, {});
    await s.svc.markPaid(intent.id, "pay_L1", 10500, "test");
    await s.orders.settle(s.user, s.order.id, { payments: [{ mode: "UPI", amount: 105 }] });
    return { ...s, pool, intent };
  }

  it("refunds against the captured payment id, using the refund id as receipt", async () => {
    const s = await paidOrder();
    const calls: Captured[] = [];
    s.pool.intercept({ path: "/v1/payments/pay_L1/refund", method: "POST" }).reply(capture(calls, { id: "rfnd_1", status: "pending", amount: 4000 }));
    const res = await s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 40, mode: "UPI", requestKey: "k1" });
    expect(res).toMatchObject({ status: "PENDING", gatewayRef: "rfnd_1" });
    expect(calls[0].body).toMatchObject({ amount: 4000, receipt: res.id });

    // Signed refund.processed webhook settles the reservation.
    const body = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", receipt: res.id, status: "processed" } } } });
    await s.svc.handleRazorpayWebhook(Buffer.from(body), sign(body), "evt_r1");
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("PROCESSED");
  });

  it("parks a timed-out refund as UNKNOWN and the recovery job resolves it by receipt without resubmitting", async () => {
    const s = await paidOrder();
    s.pool.intercept({ path: "/v1/payments/pay_L1/refund", method: "POST" }).replyWithError(new Error("socket hang up"));
    const res = await s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 105, mode: "UPI", requestKey: "k2" });
    expect(res.status).toBe("UNKNOWN");
    // The reservation still blocks a second refund of the same balance.
    await expect(s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 1, mode: "CASH" })).rejects.toThrow("exceeds");

    const lookups: Captured[] = [];
    s.pool.intercept({ path: "/v1/payments/pay_L1/refunds?count=100", method: "GET" })
      .reply(capture(lookups, { items: [{ id: "rfnd_late", status: "processed", receipt: res.id, amount: 10500 }] }));
    const tick = await s.svc.recoveryTick(new Date(Date.now() + 10 * 60_000));
    expect(tick.refunds).toBe(1);
    expect(lookups).toHaveLength(1);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: res.id } })).toMatchObject({ status: "PROCESSED", gatewayRef: "rfnd_late" });
  });

  it("a refund.failed webhook releases the reserved balance", async () => {
    const s = await paidOrder();
    s.pool.intercept({ path: "/v1/payments/pay_L1/refund", method: "POST" }).reply(200, { id: "rfnd_f", status: "pending", amount: 10500 });
    const res = await s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 105, mode: "UPI" });
    const body = JSON.stringify({ event: "refund.failed", payload: { refund: { entity: { id: "rfnd_f", receipt: res.id, status: "failed" } } } });
    await s.svc.handleRazorpayWebhook(Buffer.from(body), sign(body), "evt_f");
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("FAILED");
    const cashRefund = await s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 105, mode: "CASH" });
    expect(cashRefund.status).toBe("PROCESSED");
  });

  it("records an electronic refund with no captured gateway payment as MANUAL without calling Razorpay", async () => {
    const s = await setup(new RazorpayGateway(cfg));
    await s.orders.settle(s.user, s.order.id, { payments: [{ mode: "CARD", amount: 105 }] });
    const res = await s.cash.refund(s.user, s.outlet.id, s.order.id, { amount: 10, mode: "CARD" });
    expect(res.status).toBe("MANUAL");
  });

  it("expires an unpaid QR past its deadline and closes it at Razorpay", async () => {
    const s = await setup(new RazorpayGateway(cfg));
    s.rt.emit.mockClear();
    http.agent.get(RZP).intercept({ path: "/v1/payments/qr_codes", method: "POST" }).reply(200, { id: "qr_E", status: "active", close_by: Math.floor(Date.now() / 1000) + 900 });
    const intent = await s.svc.createCollect(s.user, s.outlet.id, s.order.id, {});
    const closes: Captured[] = [];
    const pool = http.agent.get(RZP);
    pool.intercept({ path: "/v1/payments/qr_codes/qr_E", method: "GET" }).reply(200, { id: "qr_E", status: "active" });
    pool.intercept({ path: "/v1/payments/qr_codes/qr_E/payments", method: "GET" }).reply(200, { items: [] });
    pool.intercept({ path: "/v1/payments/qr_codes/qr_E/close", method: "POST" }).reply(capture(closes, { id: "qr_E", status: "closed" }));
    await s.svc.recoveryTick(new Date(Date.now() + 60 * 60_000));
    expect(closes).toHaveLength(1);
    expect((await prisma.gatewayPayment.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe("EXPIRED");
  });
});
