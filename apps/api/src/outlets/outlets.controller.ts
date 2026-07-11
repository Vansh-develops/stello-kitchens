import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch } from "@nestjs/common";
import type { AreaDto, AuthUser, OutletDto, UpdateOutletInput } from "@stello/shared";
import { UpdateOutletSchema } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";

@Controller("outlets")
export class OutletsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<OutletDto[]> {
    const outlets = await this.prisma.outlet.findMany({
      where: { tenantId: user.tenantId, id: { in: user.outletIds } },
      include: { brand: true },
      orderBy: { name: "asc" },
    });
    return outlets.map((o) => ({
      id: o.id,
      name: o.name,
      brandName: o.brand.name,
      brandId: o.brandId,
      themeId: o.brand.themeId,
      address: o.address,
    }));
  }

  @Get(":outletId/tables")
  async tables(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
  ): Promise<AreaDto[]> {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    const areas = await this.prisma.area.findMany({
      where: { tenantId: user.tenantId, outletId },
      include: { tables: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    });
    const openOrders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "OPEN", tableId: { not: null } },
      select: { id: true, tableId: true },
    });
    const occupied = new Map(openOrders.map((o) => [o.tableId as string, o.id]));
    return areas.map((a) => ({
      id: a.id,
      name: a.name,
      tables: a.tables.map((t) => ({
        id: t.id,
        name: t.name,
        seats: t.seats,
        occupiedByOrderId: occupied.get(t.id) ?? null,
      })),
    }));
  }

  @RequirePermission("settings.manage")
  @Patch(":outletId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(UpdateOutletSchema)) body: UpdateOutletInput,
  ) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    // Scoped ownership read before the id-keyed update (the tenant-guard passes
    // update-by-id through unscoped, so a path check alone is not enough).
    const owned = await this.prisma.outlet.findFirst({
      where: { id: outletId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Outlet not found");
    const updated = await this.prisma.outlet.update({ where: { id: outletId }, data: body });
    return { id: updated.id };
  }
}
