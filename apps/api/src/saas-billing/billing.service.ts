import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  PAYMENT_GRACE_DAYS,
  canTransition,
  limitBlockers,
  nextSubscriptionStatus,
  saasInvoiceAmounts,
  tenantStatusFor,
  type AuthUser,
  type BillingCycle,
  type PlatformSubscriptionActionInput,
  type PlatformSubscriptionRowDto,
  type PlanDto,
  type SubscribeInput,
  type SubscriptionDto,
  type SubscriptionEvent,
  type SubscriptionInvoiceDto,
  type SubscriptionStatus,
  type UpdatePlanInput,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { EntitlementsService, toPlanDto } from "./entitlements.service";
import { SAAS_BILLING_PROVIDER, type BillingWebhookEvent, type SaasBillingProvider } from "./billing.provider";

type Tx = Prisma.TransactionClient;
type SubRow = Prisma.TenantSubscriptionGetPayload<{ include: { plan: true } }>;

const DAY = 86_400_000;

export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  if (cycle === "YEARLY") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Indian financial year label for a date, e.g. 2026-10-26 → "2026-27". */
export function financialYear(d: Date): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * Stello's own subscription billing: plan changes, invoices, collection through
 * the provider seam, and the lifecycle state machine (shared/growth.ts). Every
 * status change goes through `transition`, which locks the subscription row,
 * validates the move, mirrors Tenant.status and writes a SubscriptionEvent.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger("SaasBilling");

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    @Inject(SAAS_BILLING_PROVIDER) private readonly provider: SaasBillingProvider,
  ) {}

  // ---------- tenant-facing ----------

  async getSubscription(tenantId: string): Promise<SubscriptionDto> {
    const sub = await this.entitlements.ensureSubscription(tenantId);
    const [usage, invoices, plans] = await Promise.all([
      this.entitlements.usage(tenantId),
      this.prisma.subscriptionInvoice.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 24,
      }),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    ]);
    return {
      status: sub.status,
      plan: toPlanDto(sub.plan),
      billingCycle: sub.billingCycle as BillingCycle,
      trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      provider: sub.provider,
      checkoutUrl: sub.checkoutUrl,
      usage,
      invoices: invoices.map((i) => this.toInvoiceDto(i)),
      plans: plans.map(toPlanDto),
    };
  }

  async getInvoice(tenantId: string, id: string) {
    const inv = await this.prisma.subscriptionInvoice.findFirst({ where: { id, tenantId } });
    if (!inv) throw new NotFoundException("Invoice not found");
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    return { ...this.toInvoiceDto(inv), tenantName: tenant?.name ?? "", providerRef: inv.providerRef };
  }

  /** Start paying, change plan/cycle, or resume a subscription set to cancel. */
  async subscribe(user: AuthUser, input: SubscribeInput): Promise<SubscriptionDto> {
    const sub = await this.entitlements.ensureSubscription(user.tenantId);
    const plan = await this.prisma.plan.findFirst({ where: { code: input.planCode, isActive: true } });
    if (!plan) throw new NotFoundException("Plan not found");
    const planDto = toPlanDto(plan);

    // Downgrade rule: current usage must fit the target plan.
    const blockers = limitBlockers(planDto.limits, await this.entitlements.usage(user.tenantId));
    if (blockers.length) {
      throw new ConflictException({
        code: "PLAN_LIMIT_EXCEEDED",
        blockers,
        message: `Current usage exceeds the ${plan.name} plan (${blockers.join(", ")}). Remove some first.`,
      });
    }

    const live = sub.status === "ACTIVE" || sub.status === "PAST_DUE";
    if (live) {
      const samePlan = sub.planId === plan.id && sub.billingCycle === input.billingCycle;
      if (samePlan && !sub.cancelAtPeriodEnd) throw new ConflictException("You're already on this plan");
      if (!samePlan && sub.providerSubscriptionId) {
        await this.provider.changePlan(sub.providerSubscriptionId, this.providerPlanId(planDto, input.billingCycle));
      }
      await this.prisma.tenantSubscription.update({
        where: { id: sub.id },
        data: { planId: plan.id, billingCycle: input.billingCycle, cancelAtPeriodEnd: false },
      });
      await this.logEvent(this.prisma, user.tenantId, samePlan ? "RESUMED" : "PLAN_CHANGED", sub.status, sub.status, {
        from: sub.plan.code, to: plan.code, cycle: input.billingCycle,
      });
      // Plan changes take effect now; the next renewal invoice bills the new price (no proration).
      return this.getSubscription(user.tenantId);
    }

    // TRIAL / SUSPENDED / CANCELLED → start a fresh paid subscription.
    const created = await this.provider.createSubscription({
      tenantId: user.tenantId,
      planCode: plan.code,
      providerPlanId: this.providerPlanId(planDto, input.billingCycle),
      cycle: input.billingCycle,
      customerName: user.name,
      customerEmail: user.email,
    });
    await this.prisma.tenantSubscription.update({
      where: { id: sub.id },
      data: {
        planId: plan.id,
        billingCycle: input.billingCycle,
        provider: this.provider.name,
        providerSubscriptionId: created.providerSubscriptionId,
        checkoutUrl: created.checkoutUrl,
        cancelAtPeriodEnd: false,
      },
    });
    if (created.chargesImmediately) {
      const now = new Date();
      const invoice = await this.createInvoice(user.tenantId, sub.id, planDto, input.billingCycle, now);
      await this.collect(invoice.id);
    }
    return this.getSubscription(user.tenantId);
  }

  async cancel(user: AuthUser): Promise<SubscriptionDto> {
    const sub = await this.entitlements.ensureSubscription(user.tenantId);
    if (sub.status === "ACTIVE") {
      if (sub.providerSubscriptionId) await this.provider.cancelSubscription(sub.providerSubscriptionId, true);
      await this.prisma.tenantSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
      await this.logEvent(this.prisma, user.tenantId, "CANCEL_SCHEDULED", "ACTIVE", "ACTIVE", null);
    } else {
      if (sub.providerSubscriptionId) await this.provider.cancelSubscription(sub.providerSubscriptionId, false);
      await this.transition(user.tenantId, "CANCEL");
    }
    return this.getSubscription(user.tenantId);
  }

  /** Retry an open/failed invoice now (e.g. after updating the payment method). */
  async payInvoice(user: AuthUser, invoiceId: string): Promise<SubscriptionDto> {
    const inv = await this.prisma.subscriptionInvoice.findFirst({ where: { id: invoiceId, tenantId: user.tenantId } });
    if (!inv) throw new NotFoundException("Invoice not found");
    if (inv.status !== "OPEN" && inv.status !== "FAILED") throw new BadRequestException("Invoice is not payable");
    await this.collect(inv.id);
    return this.getSubscription(user.tenantId);
  }

  // ---------- lifecycle core ----------

  /** Apply a state-machine event under a row lock and mirror Tenant.status. */
  async transition(
    tenantId: string,
    event: SubscriptionEvent,
    patch: Prisma.TenantSubscriptionUpdateInput = {},
    data: Record<string, unknown> | null = null,
    tx?: Tx,
  ): Promise<SubscriptionStatus> {
    const run = async (db: Tx) => {
      await db.$queryRaw`SELECT id FROM tenant_subscriptions WHERE "tenantId" = ${tenantId} FOR UPDATE`;
      const sub = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
      const to = nextSubscriptionStatus(sub.status, event);
      await db.tenantSubscription.update({ where: { id: sub.id }, data: { ...patch, status: to } });
      await db.tenant.update({ where: { id: tenantId }, data: { status: tenantStatusFor(to) } });
      await this.logEvent(db, tenantId, event, sub.status, to, data);
      return to;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  private async createInvoice(tenantId: string, subscriptionId: string, plan: PlanDto, cycle: BillingCycle, periodStart: Date) {
    const subtotal = cycle === "YEARLY" ? plan.priceYearly : plan.priceMonthly;
    const amounts = saasInvoiceAmounts(subtotal);
    return this.prisma.$transaction(async (tx) => {
      const number = await this.nextInvoiceNumber(tx, periodStart);
      return tx.subscriptionInvoice.create({
        data: {
          tenantId, subscriptionId, number, planCode: plan.code, billingCycle: cycle,
          periodStart, periodEnd: addCycle(periodStart, cycle), ...amounts,
          dueAt: periodStart, status: "OPEN",
        },
      });
    });
  }

  /** Gap-free invoice series per financial year: STL/2026-27/00001. */
  private async nextInvoiceNumber(tx: Tx, at: Date): Promise<string> {
    const fy = financialYear(at);
    const key = `saas-invoice:${fy}`;
    const rows = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO billing_counters (key, value) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET value = billing_counters.value + 1
      RETURNING value`;
    return `STL/${fy}/${String(rows[0].value).padStart(5, "0")}`;
  }

  /** Charge an invoice through the provider and apply the outcome. */
  private async collect(invoiceId: string): Promise<void> {
    const inv = await this.prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { subscription: true },
    });
    const result = await this.provider.chargeInvoice({
      invoiceNumber: inv.number,
      amount: inv.total,
      providerSubscriptionId: inv.subscription.providerSubscriptionId,
    });
    if (result.status === "PAID") await this.markPaid(inv.id, result.providerRef);
    else if (result.status === "FAILED") await this.markFailed(inv.id);
    else await this.prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { attempts: { increment: 1 } } });
  }

  async markPaid(invoiceId: string, providerRef: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (inv.status === "PAID") return; // idempotent (webhook replays)
      await tx.subscriptionInvoice.update({
        where: { id: inv.id },
        data: { status: "PAID", paidAt: new Date(), providerRef, attempts: { increment: 1 } },
      });
      await this.transition(
        inv.tenantId,
        "PAYMENT_SUCCEEDED",
        {
          currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd, graceEndsAt: null,
          trialEndsAt: null, checkoutUrl: null,
        },
        { invoice: inv.number },
        tx,
      );
    });
  }

  async markFailed(invoiceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const inv = await tx.subscriptionInvoice.update({
        where: { id: invoiceId },
        data: { status: "FAILED", attempts: { increment: 1 } },
      });
      const sub = await tx.tenantSubscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
      if (canTransition(sub.status, "PAYMENT_FAILED")) {
        await this.transition(
          inv.tenantId,
          "PAYMENT_FAILED",
          // The grace window starts at the first failure and is not extended by retries.
          { graceEndsAt: sub.graceEndsAt ?? new Date(Date.now() + PAYMENT_GRACE_DAYS * DAY) },
          { invoice: inv.number },
          tx,
        );
      } else {
        await this.logEvent(tx, inv.tenantId, "PAYMENT_FAILED", sub.status, sub.status, { invoice: inv.number });
      }
    });
  }

  /**
   * Time-driven transitions for every tenant: unpaid trials expire, grace periods
   * lapse, scheduled cancellations take effect, and (for providers we charge
   * ourselves, i.e. the mock) renewals are invoiced and collected.
   */
  async runCycle(now = new Date()) {
    const out = { trialsExpired: 0, renewed: 0, renewalFailed: 0, suspended: 0, cancelled: 0 };
    await runUnscoped(async () => {
      const due = await this.prisma.tenantSubscription.findMany({
        where: {
          OR: [
            { status: "TRIAL", trialEndsAt: { lte: now } },
            { status: "ACTIVE", currentPeriodEnd: { lte: now } },
            { status: "PAST_DUE", graceEndsAt: { lte: now } },
          ],
        },
        include: { plan: true },
      });
      for (const sub of due) {
        try {
          if (sub.status === "TRIAL") {
            await this.transition(sub.tenantId, "TRIAL_EXPIRED");
            out.trialsExpired++;
          } else if (sub.status === "PAST_DUE") {
            await this.transition(sub.tenantId, "GRACE_EXPIRED");
            out.suspended++;
          } else if (sub.cancelAtPeriodEnd) {
            await this.transition(sub.tenantId, "PERIOD_ENDED");
            out.cancelled++;
          } else if (sub.provider === "mock" || !sub.providerSubscriptionId) {
            const ok = await this.renew(sub);
            if (ok) out.renewed++;
            else out.renewalFailed++;
          }
        } catch (err) {
          this.logger.warn(`cycle failed for tenant ${sub.tenantId}: ${(err as Error).message}`);
        }
      }
    });
    return out;
  }

  private async renew(sub: SubRow): Promise<boolean> {
    const periodStart = sub.currentPeriodEnd!;
    const existing = await this.prisma.subscriptionInvoice.findFirst({
      where: { subscriptionId: sub.id, periodStart, status: { in: ["OPEN", "FAILED"] } },
    });
    const invoice =
      existing ??
      (await this.createInvoice(sub.tenantId, sub.id, toPlanDto(sub.plan), sub.billingCycle as BillingCycle, periodStart));
    await this.collect(invoice.id);
    const after = await this.prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return after.status === "PAID";
  }

  // ---------- webhooks ----------

  async handleWebhook(rawBody: string, signature: string | undefined, eventId: string | undefined, body: unknown) {
    if (!this.provider.verifyWebhook(rawBody, signature)) throw new BadRequestException("Invalid signature");
    const evt = this.provider.parseWebhook(body, eventId);
    if (!evt) return { ok: true, ignored: true };
    return runUnscoped(() => this.applyWebhook(evt));
  }

  async applyWebhook(evt: BillingWebhookEvent) {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { providerSubscriptionId: evt.providerSubscriptionId },
      include: { plan: true },
    });
    if (!sub) return { ok: true, ignored: true };
    // Idempotency: the event id is unique; a replay hits the constraint and is skipped.
    try {
      await this.prisma.subscriptionEvent.create({
        data: { tenantId: sub.tenantId, type: `WEBHOOK_${evt.type}`, providerEventId: evt.eventId, data: { ...evt } as never },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: true, duplicate: true };
      throw err;
    }

    if (evt.type === "CHARGED") {
      const periodStart = evt.periodStart ?? sub.currentPeriodEnd ?? new Date();
      let inv = await this.prisma.subscriptionInvoice.findFirst({
        where: { subscriptionId: sub.id, periodStart, status: { in: ["OPEN", "FAILED"] } },
      });
      if (!inv) {
        const plan = toPlanDto(sub.plan);
        inv = await this.createInvoice(sub.tenantId, sub.id, plan, sub.billingCycle as BillingCycle, periodStart);
      }
      if (evt.periodEnd) {
        await this.prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { periodEnd: evt.periodEnd } });
      }
      await this.markPaid(inv.id, evt.paymentId);
    } else if (evt.type === "PAYMENT_FAILED") {
      const open = await this.prisma.subscriptionInvoice.findFirst({
        where: { subscriptionId: sub.id, status: { in: ["OPEN", "FAILED"] } },
        orderBy: { createdAt: "desc" },
      });
      if (open) await this.markFailed(open.id);
      else if (canTransition(sub.status, "PAYMENT_FAILED")) {
        await this.transition(sub.tenantId, "PAYMENT_FAILED", {
          graceEndsAt: sub.graceEndsAt ?? new Date(Date.now() + PAYMENT_GRACE_DAYS * DAY),
        });
      }
    } else if (evt.type === "HALTED") {
      const event: SubscriptionEvent = canTransition(sub.status, "GRACE_EXPIRED") ? "GRACE_EXPIRED" : "ADMIN_SUSPEND";
      if (canTransition(sub.status, event)) await this.transition(sub.tenantId, event);
    } else if (evt.type === "CANCELLED") {
      const event: SubscriptionEvent = sub.status === "ACTIVE" ? "PERIOD_ENDED" : "CANCEL";
      if (canTransition(sub.status, event)) await this.transition(sub.tenantId, event);
    }
    return { ok: true };
  }

  // ---------- platform admin ----------

  async platformList(): Promise<PlatformSubscriptionRowDto[]> {
    return runUnscoped(async () => {
      const tenants = await this.prisma.tenant.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true } });
      const rows: PlatformSubscriptionRowDto[] = [];
      for (const t of tenants) {
        const sub = await this.entitlements.ensureSubscription(t.id);
        const plan = toPlanDto(sub.plan);
        const [usage, openInvoices] = await Promise.all([
          this.entitlements.usage(t.id),
          this.prisma.subscriptionInvoice.count({ where: { tenantId: t.id, status: { in: ["OPEN", "FAILED"] } } }),
        ]);
        const paying = sub.status === "ACTIVE" || sub.status === "PAST_DUE";
        rows.push({
          tenantId: t.id,
          tenantName: t.name,
          status: sub.status,
          planCode: plan.code,
          planName: plan.name,
          billingCycle: sub.billingCycle as BillingCycle,
          mrr: paying ? (sub.billingCycle === "YEARLY" ? Math.round(plan.priceYearly / 12) : plan.priceMonthly) : 0,
          trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
          usage,
          limits: plan.limits,
          openInvoices,
        });
      }
      return rows;
    });
  }

  async platformAction(tenantId: string, input: PlatformSubscriptionActionInput) {
    return runUnscoped(async () => {
      const sub = await this.entitlements.ensureSubscription(tenantId);
      switch (input.action) {
        case "extend_trial": {
          if (sub.status !== "TRIAL" && sub.status !== "SUSPENDED") {
            throw new BadRequestException("Only trial or suspended tenants can get a trial extension");
          }
          const base = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt : new Date();
          const trialEndsAt = new Date(base.getTime() + input.days * DAY);
          await this.prisma.$transaction(async (tx) => {
            await tx.tenantSubscription.update({ where: { id: sub.id }, data: { status: "TRIAL", trialEndsAt } });
            await tx.tenant.update({ where: { id: tenantId }, data: { status: "TRIAL", trialEndsAt } });
            await this.logEvent(tx, tenantId, "TRIAL_EXTENDED", sub.status, "TRIAL", { days: input.days });
          });
          break;
        }
        case "suspend":
          await this.transition(tenantId, "ADMIN_SUSPEND");
          break;
        case "reactivate": {
          const now = new Date();
          await this.transition(tenantId, "ADMIN_REACTIVATE", {
            graceEndsAt: null,
            currentPeriodStart: sub.currentPeriodEnd && sub.currentPeriodEnd > now ? undefined : now,
            currentPeriodEnd:
              sub.currentPeriodEnd && sub.currentPeriodEnd > now ? undefined : addCycle(now, sub.billingCycle as BillingCycle),
          });
          break;
        }
        case "cancel":
          await this.transition(tenantId, "CANCEL");
          break;
        case "change_plan": {
          const plan = await this.prisma.plan.findUnique({ where: { code: input.planCode } });
          if (!plan) throw new NotFoundException("Plan not found");
          await this.prisma.tenantSubscription.update({ where: { id: sub.id }, data: { planId: plan.id } });
          await this.logEvent(this.prisma, tenantId, "PLAN_CHANGED", sub.status, sub.status, {
            from: sub.plan.code, to: plan.code, by: "platform",
          });
          break;
        }
      }
      return { ok: true };
    });
  }

  async listPlans(): Promise<PlanDto[]> {
    await this.entitlements.ensurePlans();
    const plans = await this.prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
    return plans.map(toPlanDto);
  }

  async updatePlan(code: string, input: UpdatePlanInput): Promise<PlanDto> {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new NotFoundException("Plan not found");
    const updated = await this.prisma.plan.update({
      where: { code },
      data: {
        name: input.name,
        priceMonthly: input.priceMonthly,
        priceYearly: input.priceYearly,
        limits: input.limits,
        features: input.features,
        isActive: input.isActive,
        providerPlanId: input.providerPlanIds,
      },
    });
    return toPlanDto(updated);
  }

  // ---------- helpers ----------

  private providerPlanId(plan: PlanDto, cycle: BillingCycle): string | null {
    return plan.providerPlanIds?.[cycle] ?? null;
  }

  private async logEvent(
    db: Tx | PrismaService,
    tenantId: string,
    type: string,
    fromStatus: string | null,
    toStatus: string | null,
    data: Record<string, unknown> | null,
  ) {
    await db.subscriptionEvent.create({
      data: { tenantId, type, fromStatus, toStatus, data: (data ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  }

  private toInvoiceDto(i: {
    id: string; number: string; planCode: string; billingCycle: string; periodStart: Date; periodEnd: Date;
    subtotal: number; taxAmount: number; total: number; status: string; dueAt: Date; paidAt: Date | null;
  }): SubscriptionInvoiceDto {
    return {
      id: i.id,
      number: i.number,
      planCode: i.planCode,
      billingCycle: i.billingCycle as BillingCycle,
      periodStart: i.periodStart.toISOString(),
      periodEnd: i.periodEnd.toISOString(),
      subtotal: i.subtotal,
      taxAmount: i.taxAmount,
      total: i.total,
      status: i.status as SubscriptionInvoiceDto["status"],
      dueAt: i.dueAt.toISOString(),
      paidAt: i.paidAt?.toISOString() ?? null,
    };
  }
}
