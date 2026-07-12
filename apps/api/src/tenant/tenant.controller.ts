import { Controller, Get, NotFoundException, Post } from "@nestjs/common";
import type { AuthUser, TenantSummaryDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("tenant")
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async current(@CurrentUser() user: AuthUser): Promise<TenantSummaryDto> {
    const t = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!t) throw new NotFoundException("Tenant not found");
    return {
      id: t.id, name: t.name, status: t.status, createdVia: t.createdVia,
      onboardedAt: t.onboardedAt ? t.onboardedAt.toISOString() : null,
    };
  }

  @RequirePermission("settings.manage")
  @Post("onboarding/complete")
  async complete(@CurrentUser() user: AuthUser): Promise<{ onboardedAt: string }> {
    const t = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { onboardedAt: new Date() },
    });
    return { onboardedAt: t.onboardedAt!.toISOString() };
  }
}
