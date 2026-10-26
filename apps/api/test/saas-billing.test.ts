import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { BillingService, financialYear } from "../src/saas-billing/billing.service";
import { EntitlementsService } from "../src/saas-billing/entitlements.service";
import { MockSaasBillingProvider, RazorpaySubscriptionsProvider } from "../src/saas-billing/billing.provider";
import { enterTenant } from "../src/common/tenant-context";
import { testPrisma } from "./db";

const DAY = 86_400_000;

function make(provider: MockSaasBillingProvider | RazorpaySubscriptionsProvider = new MockSaasBillingProvider()) {
  const prisma = new PrismaService();
  const entitlements = new EntitlementsService(prisma);
  return { billing: new BillingService(prisma, entitlements, provider), entitlements, provider };
}

async function tenantWithOwner(name = "Masala Co") {
  const tenant = await testPrisma.tenant.create({ data: { name, trialEndsAt: new Date(Date.now() + 10 * DAY) } });
  const user = {
    id: "owner", tenantId: tenant.id, email: "owner@masala.test", name: "Owner", roleName: "Owner",
    permissions: ["*"], outletIds: [], isPlatformAdmin: false,
  } as any;
  return { tenant, user };
}

describe("subscription lifecycle", () => {
  it("starts every tenant on a trial mirrored from the tenant row", async () => {
    const { tenant } = await tenantWithOwner();
    const { billing } = make();
    const sub = await billing.getSubscription(tenant.id);
    expect(sub.status).toBe("TRIAL");
    expect(sub.plan.code).toBe("growth");
    expect(new Date(sub.trialEndsAt!).getTime()).toBe(tenant.trialEndsAt!.getTime());
    expect(sub.plans.map((p) => p.code)).toEqual(["starter", "growth", "chain"]);
  });

  it("trial → active on first payment, with a GST invoice in the FY series", async () => {
    const { tenant, user } = await tenantWithOwner();
    const { billing } = make();
    const sub = await billing.subscribe(user, { planCode: "starter", billingCycle: "MONTHLY" });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.plan.code).toBe("starter");
    expect(sub.invoices).toHaveLength(1);
    expect(sub.invoices[0]).toMatchObject({ status: "PAID", subtotal: 99900, taxAmount: 17982, total: 117882 });
    expect(sub.invoices[0].number).toBe(`STL/${financialYear(new Date())}/00001`);
    expect((await testPrisma.tenant.findUnique({ where: { id: tenant.id } }))?.status).toBe("ACTIVE");

    const { user: u2 } = await tenantWithOwner("Second");
    const sub2 = await billing.subscribe(u2, { planCode: "starter", billingCycle: "YEARLY" });
    expect(sub2.invoices[0].number).toBe(`STL/${financialYear(new Date())}/00002`);
    expect(sub2.invoices[0].subtotal).toBe(999000);
  });

  it("failed renewal → past_due (grace) → suspended → active after paying", async () => {
    const { tenant, user } = await tenantWithOwner();
    const provider = new MockSaasBillingProvider();
    const { billing } = make(provider);
    await billing.subscribe(user, { planCode: "growth", billingCycle: "MONTHLY" });
    const sub = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });

    provider.failCharges = true;
    const r1 = await billing.runCycle(new Date(sub.currentPeriodEnd!.getTime() + 1000));
    expect(r1.renewalFailed).toBe(1);
    let now = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(now.status).toBe("PAST_DUE");
    expect(now.graceEndsAt).not.toBeNull();
    expect((await testPrisma.tenant.findUnique({ where: { id: tenant.id } }))?.status).toBe("ACTIVE"); // still works in grace

    const r2 = await billing.runCycle(new Date(now.graceEndsAt!.getTime() + 1000));
    expect(r2.suspended).toBe(1);
    expect((await testPrisma.tenant.findUnique({ where: { id: tenant.id } }))?.status).toBe("SUSPENDED");

    provider.failCharges = false;
    const failed = await testPrisma.subscriptionInvoice.findFirstOrThrow({ where: { tenantId: tenant.id, status: "FAILED" } });
    const paid = await billing.payInvoice(user, failed.id);
    expect(paid.status).toBe("ACTIVE");
    now = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(now.graceEndsAt).toBeNull();
    expect(now.currentPeriodStart?.getTime()).toBe(failed.periodStart.getTime());

    const events = await testPrisma.subscriptionEvent.findMany({ where: { tenantId: tenant.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["ACTIVE", "PAST_DUE", "SUSPENDED", "ACTIVE"]);
  });

  it("renews a paid period and suspends an unpaid trial", async () => {
    const { tenant, user } = await tenantWithOwner();
    const { tenant: trialTenant } = await tenantWithOwner("Trialist");
    const { billing } = make();
    await testPrisma.tenant.update({ where: { id: trialTenant.id }, data: { trialEndsAt: new Date(Date.now() + 60 * DAY) } });
    await billing.getSubscription(trialTenant.id);
    await billing.subscribe(user, { planCode: "growth", billingCycle: "MONTHLY" });
    const sub = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });

    const res = await billing.runCycle(new Date(sub.currentPeriodEnd!.getTime() + 1000));
    expect(res).toMatchObject({ renewed: 1, trialsExpired: 0 });
    const renewed = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(renewed.currentPeriodStart?.getTime()).toBe(sub.currentPeriodEnd!.getTime());
    expect(await testPrisma.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: "PAID" } })).toBe(2);

    const later = await billing.runCycle(new Date(Date.now() + 61 * DAY));
    expect(later.trialsExpired).toBe(1);
    expect((await testPrisma.tenant.findUnique({ where: { id: trialTenant.id } }))?.status).toBe("SUSPENDED");
  });

  it("cancel keeps access until the period ends", async () => {
    const { tenant, user } = await tenantWithOwner();
    const { billing } = make();
    await billing.subscribe(user, { planCode: "starter", billingCycle: "MONTHLY" });
    const cancelled = await billing.cancel(user);
    expect(cancelled.status).toBe("ACTIVE");
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    const res = await billing.runCycle(new Date(new Date(cancelled.currentPeriodEnd!).getTime() + 1000));
    expect(res.cancelled).toBe(1);
    expect((await testPrisma.tenantSubscription.findUnique({ where: { tenantId: tenant.id } }))?.status).toBe("CANCELLED");
  });

  it("blocks a downgrade that current usage doesn't fit", async () => {
    const { tenant, user } = await tenantWithOwner();
    const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: "B" } });
    await testPrisma.outlet.createMany({
      data: [1, 2].map((n) => ({ tenantId: tenant.id, brandId: brand.id, name: `O${n}` })),
    });
    const { billing } = make();
    await expect(billing.subscribe(user, { planCode: "starter", billingCycle: "MONTHLY" })).rejects.toMatchObject({
      response: { code: "PLAN_LIMIT_EXCEEDED", blockers: ["outlets"] },
    });
    const ok = await billing.subscribe(user, { planCode: "growth", billingCycle: "MONTHLY" });
    expect(ok.status).toBe("ACTIVE");
  });

  it("platform admin can extend a trial and reactivate a suspended tenant", async () => {
    const { tenant } = await tenantWithOwner();
    const { billing } = make();
    await billing.platformAction(tenant.id, { action: "suspend" });
    expect((await testPrisma.tenant.findUnique({ where: { id: tenant.id } }))?.status).toBe("SUSPENDED");
    await billing.platformAction(tenant.id, { action: "extend_trial", days: 7 });
    const t = await testPrisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(t.status).toBe("TRIAL");
    expect(t.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    const rows = await billing.platformList();
    expect(rows.find((r) => r.tenantId === tenant.id)).toMatchObject({ status: "TRIAL", planCode: "growth", mrr: 0 });
  });
});

describe("razorpay subscriptions webhook", () => {
  const secret = "whsec_test";
  const provider = new RazorpaySubscriptionsProvider("rzp_test", "key", secret, (async () => {
    throw new Error("no network in tests");
  }) as any);

  it("verifies signatures, activates on charge and ignores replays", async () => {
    const { tenant } = await tenantWithOwner();
    const { billing } = make(provider);
    await billing.getSubscription(tenant.id);
    await testPrisma.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { provider: "razorpay", providerSubscriptionId: "sub_ABC" },
    });
    const start = Math.floor(Date.now() / 1000);
    const body = {
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_ABC", current_start: start, current_end: start + 30 * 86400 } },
        payment: { entity: { id: "pay_123", amount: 294882 } },
      },
    };
    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", secret).update(raw).digest("hex");

    await expect(billing.handleWebhook(raw, "bad", "evt_1", body)).rejects.toThrow(/signature/);
    await billing.handleWebhook(raw, sig, "evt_1", body);
    const dup = await billing.handleWebhook(raw, sig, "evt_1", body);
    expect(dup).toMatchObject({ duplicate: true });

    const sub = await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub.status).toBe("ACTIVE");
    const invoices = await testPrisma.subscriptionInvoice.findMany({ where: { tenantId: tenant.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "PAID", providerRef: "pay_123" });

    const pending = { event: "subscription.pending", payload: { subscription: { entity: { id: "sub_ABC" } } } };
    const raw2 = JSON.stringify(pending);
    await billing.handleWebhook(raw2, createHmac("sha256", secret).update(raw2).digest("hex"), "evt_2", pending);
    expect((await testPrisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).status).toBe("PAST_DUE");
  });

  it("is reachable only for the tenant's own invoices", async () => {
    const { user } = await tenantWithOwner();
    const { user: other } = await tenantWithOwner("Other");
    const { billing } = make();
    const sub = await billing.subscribe(user, { planCode: "starter", billingCycle: "MONTHLY" });
    enterTenant(other.tenantId);
    await expect(billing.getInvoice(other.tenantId, sub.invoices[0].id)).rejects.toThrow(/not found/i);
  });
});
