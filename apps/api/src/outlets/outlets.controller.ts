import { Controller, ForbiddenException, Get, Param } from "@nestjs/common";
import type { AreaDto, AuthUser, OutletDto } from "@petpooja/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser } from "../common/decorators";

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
}
