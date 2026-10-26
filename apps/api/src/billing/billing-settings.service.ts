import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser, BillingSettingsDto, BillingSettingsInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { loadBillingRules } from "./billing-rules";

@Injectable()
export class BillingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async get(user: AuthUser, outletId: string): Promise<BillingSettingsDto> {
    this.assertOutlet(user, outletId);
    const rules = await this.prisma.$transaction((tx) => loadBillingRules(tx, user.tenantId, outletId));
    return {
      outletId,
      serviceChargeEnabled: rules.serviceChargeEnabled,
      serviceChargePercent: rules.serviceChargePercent,
      serviceChargeTaxable: rules.serviceChargeTaxable,
      serviceChargeOrderTypes: rules.serviceChargeOrderTypes as BillingSettingsDto["serviceChargeOrderTypes"],
      roundOffEnabled: rules.roundOffEnabled,
      timezone: rules.timezone,
    };
  }

  /**
   * Save the outlet's billing rules. They apply to running bills on their next
   * recompute (new items or settlement); settled bills keep their snapshot.
   */
  async update(user: AuthUser, outletId: string, input: BillingSettingsInput): Promise<BillingSettingsDto> {
    this.assertOutlet(user, outletId);
    const outlet = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId } });
    if (!outlet) throw new NotFoundException("Outlet not found");
    const data = { ...input, serviceChargeOrderTypes: [...new Set(input.serviceChargeOrderTypes)] };
    await this.prisma.$transaction(async (tx) => {
      await tx.outletBillingSettings.upsert({
        where: { outletId },
        create: { tenantId: user.tenantId, outletId, ...data },
        update: data,
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: "BILLING_SETTINGS_UPDATED",
          entity: "outlet",
          entityId: outletId,
          data,
        },
      });
    });
    this.realtime.notifyOutlet(outletId);
    return this.get(user, outletId);
  }
}
