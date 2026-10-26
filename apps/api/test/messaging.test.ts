import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createTransport } from "nodemailer";
import { PrismaService } from "../src/prisma/prisma.service";
import { MessagingService } from "../src/messaging/messaging.service";
import { MessagingNotificationProvider } from "../src/messaging/messaging-notification.provider";
import { LoggingSmsTransport, LoggingWhatsAppTransport, Msg91SmsTransport, WhatsAppCloudTransport } from "../src/messaging/transports";
import { LoggingEmailProvider } from "../src/email/email.provider";
import { SmtpEmailProvider } from "../src/email/smtp.email.provider";
import { CrmService } from "../src/crm/crm.service";
import { LoyaltyOtpService } from "../src/loyalty/loyalty-otp.service";
import { capture, mockHttp, providerFixture, type Captured } from "./providers-fixture";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

const MSG91 = "https://control.msg91.com";
const GRAPH = "https://graph.facebook.com";
const msg91 = () => new Msg91SmsTransport({ authKey: "msg91-key", baseUrl: MSG91, otpTemplateId: "otp-tpl", senderId: "STELLO" });
const wa = () => new WhatsAppCloudTransport({ accessToken: "EAAG-token", phoneNumberId: "1098765", appSecret: "app-secret", graphUrl: `${GRAPH}/v21.0` });

let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
});
afterEach(() => http.restore());

describe("MSG91 transport", () => {
  it("sends our own OTP through /api/v5/otp with the authkey header and E.164 mobile", async () => {
    const calls: Captured[] = [];
    http.agent.get(MSG91).intercept({ path: (p) => p.startsWith("/api/v5/otp"), method: "POST" })
      .reply(capture(calls, { type: "success", request_id: "req-otp-1" }));
    const res = await msg91().sendOtp({ to: "98765 43210", otp: "482913" });
    expect(res).toEqual({ provider: "msg91", messageId: "req-otp-1" });
    expect(calls[0].headers.authkey).toBe("msg91-key");
    const q = new URL(calls[0].path, MSG91).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ template_id: "otp-tpl", mobile: "919876543210", otp: "482913", otp_expiry: "5" });
  });

  it("sends a DLT template through the Flow API and surfaces MSG91 'type: error' as a failure", async () => {
    const calls: Captured[] = [];
    const pool = http.agent.get(MSG91);
    pool.intercept({ path: "/api/v5/flow", method: "POST" }).reply(capture(calls, { type: "success", message: "req-flow-1" }));
    pool.intercept({ path: "/api/v5/flow", method: "POST" }).reply(200, { type: "error", message: "Template not approved" });
    const res = await msg91().sendTemplate({ to: "9876543210", templateId: "flow-1", vars: { var1: "Paneer" } });
    expect(res.messageId).toBe("req-flow-1");
    expect(calls[0].body).toEqual({ template_id: "flow-1", sender: "STELLO", short_url: "0", recipients: [{ mobiles: "919876543210", var1: "Paneer" }] });
    await expect(msg91().sendTemplate({ to: "9876543210", templateId: "flow-1", vars: {} })).rejects.toThrow("Template not approved");
  });
});

describe("WhatsApp Cloud transport", () => {
  it("posts a template message with body params and the OTP copy-code button", async () => {
    const calls: Captured[] = [];
    http.agent.get(GRAPH).intercept({ path: "/v21.0/1098765/messages", method: "POST" })
      .reply(capture(calls, { messaging_product: "whatsapp", messages: [{ id: "wamid.ABC" }] }));
    const res = await wa().sendTemplate({ to: "9876543210", template: "loyalty_otp", language: "en", bodyParams: ["482913"], buttonParam: "482913" });
    expect(res.messageId).toBe("wamid.ABC");
    expect(calls[0].headers.authorization).toBe("Bearer EAAG-token");
    expect(calls[0].body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "loyalty_otp",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "482913" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
        ],
      },
    });
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const body = Buffer.from('{"entry":[]}');
    const sig = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(wa().verifyWebhook(body, sig)).toBe(true);
    expect(wa().verifyWebhook(body, sig.replace("sha256=", ""))).toBe(false);
    expect(wa().verifyWebhook(Buffer.from('{"entry": []}'), sig)).toBe(false);
  });
});

describe("outbox, campaigns, opt-outs and OTP routing", () => {
  async function setup(live = false) {
    const f = await providerFixture(prisma);
    const svc = new MessagingService(prisma, live ? msg91() : new LoggingSmsTransport(), live ? wa() : new LoggingWhatsAppTransport(), new LoggingEmailProvider());
    const provider = new MessagingNotificationProvider(svc);
    const crm = new CrmService(prisma, provider);
    const loyalty = new LoyaltyOtpService(prisma, provider);
    return { ...f, svc, crm, loyalty };
  }

  it("queues a campaign, skips opted-out customers, rate limits per tenant and reports stats", async () => {
    const s = await setup();
    for (const phone of ["9000000001", "9000000002", "9000000003", "9000000004"]) {
      await prisma.customer.create({ data: { tenantId: s.tenant.id, outletId: s.outlet.id, phone } });
    }
    await s.svc.saveConfig(s.user, {
      smsEnabled: true, whatsappEnabled: true, emailEnabled: true, otpChannel: "SMS", templates: {}, ratePerMinute: 2,
      lowStockEnabled: true, lowStockRecipients: [],
    });
    await s.svc.optOut(s.tenant.id, { phone: "+91 90000 00004", channel: "SMS" }, "STAFF");
    const c = await s.crm.createCampaign(s.user, s.outlet.id, { name: "Diwali", channel: "SMS", segment: "ALL", message: "20% off tonight" });
    await s.crm.sendCampaign(s.user, s.outlet.id, c.id);

    let stats = await s.svc.campaignStats(s.user, c.id);
    expect(stats).toMatchObject({ QUEUED: 3, SKIPPED: 1, total: 4 });
    const first = await s.svc.processOutbox();
    expect(first).toEqual({ sent: 2, deferred: 1 });
    stats = await s.svc.campaignStats(s.user, c.id);
    expect(stats).toMatchObject({ SENT: 2, QUEUED: 1, SKIPPED: 1 });
    // The deferred message is not due yet and the minute budget is spent.
    expect(await s.svc.processOutbox()).toEqual({ sent: 0, deferred: 0 });
  });

  it("applies WhatsApp delivery receipts forward-only and records STOP as an opt-out", async () => {
    const s = await setup();
    await prisma.customer.create({ data: { tenantId: s.tenant.id, outletId: s.outlet.id, phone: "9000000009" } });
    const row = await s.svc.enqueue({ tenantId: s.tenant.id, purpose: "CAMPAIGN", channel: "WHATSAPP", to: "9000000009", body: "hi", vars: ["hi"] });
    await prisma.messageOutbox.update({ where: { id: row.id }, data: { status: "SENT", providerMessageId: "wamid.1" } });

    const payload = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "1098765" },
        statuses: [{ id: "wamid.1", status: "read" }, { id: "wamid.1", status: "delivered" }],
        messages: [{ from: "919000000009", type: "text", text: { body: "stop" } }],
      } }] }],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = `sha256=${createHmac("sha256", "dev-whatsapp-app-secret").update(raw).digest("hex")}`;
    await expect(s.svc.handleWhatsAppWebhook(raw, "sha256=00")).rejects.toThrow("Invalid signature");
    const res = await s.svc.handleWhatsAppWebhook(raw, sig);
    expect(res).toMatchObject({ updated: 1, optOuts: 1 });
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("READ");
    expect(await s.svc.isOptedOut(s.tenant.id, "+919000000009", "WHATSAPP")).toBe(true);
    const next = await s.svc.enqueue({ tenantId: s.tenant.id, purpose: "CAMPAIGN", channel: "WHATSAPP", to: "9000000009", body: "hi", vars: ["hi"] });
    expect(next.status).toBe("SKIPPED");
  });

  it("maps MSG91 delivery reports onto outbox rows by request id", async () => {
    const s = await setup();
    const row = await s.svc.enqueue({ tenantId: s.tenant.id, purpose: "CAMPAIGN", channel: "SMS", to: "9000000001", body: "x", vars: ["x"] });
    await prisma.messageOutbox.update({ where: { id: row.id }, data: { status: "SENT", providerMessageId: "req-77" } });
    const res = await s.svc.handleMsg91Report({ data: JSON.stringify([{ requestId: "req-77", report: [{ number: "919000000001", status: "1", desc: "DELIVERED" }] }]) });
    expect(res.updated).toBe(1);
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DELIVERED");
  });

  it("sends the loyalty OTP inline over WhatsApp when the tenant prefers it", async () => {
    const s = await setup(true);
    await prisma.customer.create({ data: { tenantId: s.tenant.id, outletId: s.outlet.id, phone: "9876543210", loyaltyPoints: 50 } });
    await s.svc.saveConfig(s.user, {
      smsEnabled: true, whatsappEnabled: true, emailEnabled: true, otpChannel: "WHATSAPP", ratePerMinute: 60,
      templates: { OTP: { whatsapp: { name: "loyalty_otp", language: "en" } } }, lowStockEnabled: true, lowStockRecipients: [],
    });
    const calls: Captured[] = [];
    http.agent.get(GRAPH).intercept({ path: "/v21.0/1098765/messages", method: "POST" }).reply(capture(calls, { messages: [{ id: "wamid.OTP" }] }));
    await s.loyalty.requestOtp(s.user, s.outlet.id, "9876543210");
    const otp = await prisma.loyaltyOtp.findFirstOrThrow();
    expect((calls[0].body as any).template.components[0].parameters[0].text).toBe(otp.code);
    expect(await prisma.messageOutbox.findFirstOrThrow({ where: { purpose: "OTP" } })).toMatchObject({ status: "SENT", providerMessageId: "wamid.OTP", channel: "WHATSAPP" });
  });

  it("fails an SMS OTP loudly when MSG91 rejects it, and refuses a live campaign without a DLT template", async () => {
    const s = await setup(true);
    await prisma.customer.create({ data: { tenantId: s.tenant.id, outletId: s.outlet.id, phone: "9876543210", loyaltyPoints: 50 } });
    http.agent.get(MSG91).intercept({ path: (p) => p.startsWith("/api/v5/otp"), method: "POST" }).reply(401, { type: "error", message: "Invalid authkey" });
    await expect(s.loyalty.requestOtp(s.user, s.outlet.id, "9876543210")).rejects.toThrow("Could not send SMS");
    const row = await s.svc.enqueue({ tenantId: s.tenant.id, purpose: "CAMPAIGN", channel: "SMS", to: "9876543210", body: "x", vars: ["x"] });
    await s.svc.processOutbox();
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "FAILED" });
  });
});

describe("SMTP email provider", () => {
  it("composes account and generic mail through nodemailer", async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent: any[] = [];
    const orig = transport.sendMail.bind(transport);
    (transport as any).sendMail = async (m: any) => {
      const info = await orig(m);
      sent.push(JSON.parse((info as any).message));
      return info;
    };
    const smtp = new SmtpEmailProvider({ host: "smtp.example.com", port: 587, secure: false, from: "Stello <no-reply@stello.test>" }, transport);
    await smtp.sendPasswordReset("a@b.test", "https://x.test/reset?t=1");
    await smtp.send("ops@b.test", "Low stock: Paneer", "Paneer is at 1 KG <reorder 5>");
    expect(sent[0]).toMatchObject({ subject: "Reset your Stello Kitchens password", from: { address: "no-reply@stello.test" } });
    expect(sent[0].text).toContain("https://x.test/reset?t=1");
    expect(sent[1].html).toContain("&lt;reorder 5&gt;");
  });
});
