import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  PLAN_CATALOGUE,
  TRIAL_PLAN_CODE,
  type PlanDto,
  type PlanLimits,
  type PlanResource,
  type SubscriptionStatus,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

const TRIAL_DAYS = 14;

export interface Entitlements {
  status: SubscriptionStatus;
  planCode: string;
  limits: PlanLimits;
  features: string[];
  usage: Record<PlanResource, number>;
}

type PlanRow = {
  code: string; name: string; priceMonthly: number; priceYearly: number; limits: Prisma.JsonValue;
  features: Prisma.JsonValue; providerPlanId: Prisma.JsonValue | null; isActive: boolean; sortOrder: number;
};

export function toPlanDto(p: PlanRow): PlanDto {
  const limits = (p.limits ?? {}) as Partial<PlanLimits>;
  return {
    code: p.code,
    name: p.name,
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    limits: { outlets: limits.outlets ?? null, terminals: limits.terminals ?? null, users: limits.users ?? null },
    features: (Array.isArray(p.features) ? p.features : []) as PlanDto["features"],
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    providerPlanIds: (p.providerPlanId ?? null) as PlanDto["providerPlanIds"],
  };
}

/**
 * Plans, the tenant's subscription row and live usage counts. Every tenant gets
 * a subscription lazily on first touch (tenants created before SaaS billing
 * existed, or by the provisioning flow), mirroring the tenant's current status.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Insert any catalogue plan that's missing; never overwrites platform-admin edits. */
  async ensurePlans(): Promise<void> {
    await this.prisma.plan.createMany({
      data: PLAN_CATALOGUE.map((p) => ({
        code: p.code, name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly,
        limits: p.limits, features: p.features, sortOrder: p.sortOrder,
      })),
      skipDuplicates: true,
    });
  }

  async ensureSubscription(tenantId: string) {
    const existing = await this.prisma.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (existing) return existing;
    await this.ensurePlans();
    const [tenant, plan] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.plan.findUnique({ where: { code: TRIAL_PLAN_CODE } }),
    ]);
    if (!tenant || !plan) throw new Error("Tenant or trial plan missing");
    const now = new Date();
    const status: SubscriptionStatus =
      tenant.status === "ACTIVE" ? "ACTIVE" : tenant.status === "SUSPENDED" ? "SUSPENDED" : "TRIAL";
    const trialEndsAt = tenant.trialEndsAt ?? new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
    // upsert: two concurrent first requests must not both insert.
    return this.prisma.tenantSubscription.upsert({
      where: { tenantId },
      update: {},
      create: {
        tenantId,
        planId: plan.id,
        status,
        trialEndsAt: status === "TRIAL" ? trialEndsAt : null,
        // Pre-billing ACTIVE tenants keep working for a period before their first invoice.
        currentPeriodStart: status === "ACTIVE" ? now : null,
        currentPeriodEnd: status === "ACTIVE" ? new Date(now.getTime() + 30 * 86_400_000) : null,
      },
      include: { plan: true },
    });
  }

  async usage(tenantId: string): Promise<Record<PlanResource, number>> {
    const [outlets, terminals, users, invites] = await Promise.all([
      this.prisma.outlet.count({ where: { tenantId } }),
      this.prisma.terminal.count({ where: { tenantId, isActive: true } }),
      this.prisma.user.count({ where: { tenantId, isActive: true } }),
      // Outstanding invites reserve a seat, so the limit can't be bypassed by inviting in bulk.
      this.prisma.authToken.count({
        where: { tenantId, type: "INVITE", usedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    return { outlets, terminals, users: users + invites };
  }

  async forTenant(tenantId: string): Promise<Entitlements> {
    const sub = await this.ensureSubscription(tenantId);
    const plan = toPlanDto(sub.plan);
    return {
      status: sub.status,
      planCode: plan.code,
      limits: plan.limits,
      features: plan.features,
      usage: await this.usage(tenantId),
    };
  }
}
