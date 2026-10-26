import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { withinLimit, type PlanFeature, type PlanResource } from "@stello/shared";
import { EntitlementsService } from "./entitlements.service";

const PLAN_LIMIT_KEY = "planLimit";
const PLAN_FEATURE_KEY = "planFeature";

/**
 * Enforces the tenant's subscription on a route: inactive subscriptions can't
 * create anything, gated modules need the plan feature, and creating a counted
 * resource (outlet / terminal / user seat) must stay within the plan limit.
 * Runs after the global JwtAuthGuard (method-level guards run after app guards).
 *
 * The count-then-create check is not serialised, so two simultaneous creates at
 * the boundary can overshoot by one — acceptable for commercial limits.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user;
    if (!user?.tenantId) return true; // public route — nothing to meter
    const targets = [context.getHandler(), context.getClass()];
    const resource = this.reflector.getAllAndOverride<PlanResource | undefined>(PLAN_LIMIT_KEY, targets);
    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(PLAN_FEATURE_KEY, targets);
    const ent = await this.entitlements.forTenant(user.tenantId);

    if (ent.status === "SUSPENDED" || ent.status === "CANCELLED") {
      throw new ForbiddenException({
        code: "SUBSCRIPTION_INACTIVE",
        message: "Your Stello subscription is inactive. Renew it from Billing to continue.",
      });
    }
    if (feature && !ent.features.includes(feature)) {
      throw new ForbiddenException({
        code: "PLAN_FEATURE",
        feature,
        plan: ent.planCode,
        message: `Your plan doesn't include this module (${feature}). Upgrade from Billing.`,
      });
    }
    if (resource && !withinLimit(ent.limits, ent.usage, resource)) {
      throw new ForbiddenException({
        code: "PLAN_LIMIT",
        resource,
        limit: ent.limits[resource],
        usage: ent.usage[resource],
        message: `Your plan allows ${ent.limits[resource]} ${resource}. Upgrade from Billing to add more.`,
      });
    }
    return true;
  }
}

/** Route creates one more `resource`; reject when the plan limit is reached. */
export const PlanLimit = (resource: PlanResource) =>
  applyDecorators(SetMetadata(PLAN_LIMIT_KEY, resource), UseGuards(PlanGuard));

/** Route belongs to a plan-gated module. */
export const RequireFeature = (feature: PlanFeature) =>
  applyDecorators(SetMetadata(PLAN_FEATURE_KEY, feature), UseGuards(PlanGuard));
