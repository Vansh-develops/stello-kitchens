import { Controller, ForbiddenException, Get, Param, Patch, Body } from "@nestjs/common";
import type { AuthUser, ComboDto, MenuCategoryDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { CombosService } from "../combos/combos.service";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId/menu")
export class MenuController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly combos: CombosService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  @Get()
  async getMenu(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
  ): Promise<MenuCategoryDto[]> {
    this.assertOutlet(user, outletId);
    const categories = await this.prisma.menuCategory.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          include: {
            variations: true,
            addonGroups: { include: { group: { include: { addons: true } } } },
          },
        },
      },
    });
    const combos = await this.combos.listDtos(user.tenantId, outletId);
    const combosByCategory = new Map<string, ComboDto[]>();
    for (const combo of combos) {
      const list = combosByCategory.get(combo.categoryId) ?? [];
      list.push(combo);
      combosByCategory.set(combo.categoryId, list);
    }

    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      combos: combosByCategory.get(c.id) ?? [],
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        shortCode: i.shortCode,
        price: Number(i.price),
        isVeg: i.isVeg,
        inStock: i.inStock,
        taxRate: Number(i.taxRate),
        variations: i.variations.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
        addonGroups: i.addonGroups.map((ag) => ({
          id: ag.group.id,
          name: ag.group.name,
          minSelect: ag.group.minSelect,
          maxSelect: ag.group.maxSelect,
          addons: ag.group.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price) })),
        })),
      })),
    }));
  }

  @RequirePermission("menu.stock")
  @Patch("items/:itemId/stock")
  async toggleStock(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("itemId") itemId: string,
    @Body() body: { inStock: boolean },
  ) {
    this.assertOutlet(user, outletId);
    const item = await this.prisma.item.update({
      where: { id: itemId },
      data: { inStock: !!body.inStock },
    });
    this.realtime.notifyOutlet(outletId);
    return { id: item.id, inStock: item.inStock };
  }
}
