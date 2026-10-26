import { Injectable } from "@nestjs/common";
import { classifyMenu, type AuthUser, type MenuClass, type MenuEngineeringDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { D, assertOutlet } from "./procurement.common";

/** Menu engineering: popularity × contribution margin, with recipe food cost. */
@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async menuEngineering(
    user: AuthUser,
    outletId: string,
    from: string,
    to: string,
    categoryId?: string,
  ): Promise<MenuEngineeringDto> {
    assertOutlet(user, outletId);
    const [categories, items] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { tenantId: user.tenantId, outletId, deletedAt: null },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true },
      }),
      this.prisma.item.findMany({
        where: { tenantId: user.tenantId, outletId, deletedAt: null, ...(categoryId ? { categoryId } : {}) },
        include: { category: true, recipe: { include: { material: true } } },
      }),
    ]);
    const lines = await this.prisma.orderItem.findMany({
      where: {
        itemId: { in: items.map((i) => i.id) },
        isComboComponent: false, // zero-priced combo parts would distort realised price
        order: {
          tenantId: user.tenantId,
          outletId,
          status: "SETTLED",
          deletedAt: null,
          createdAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) },
        },
      },
      select: { itemId: true, quantity: true, lineTotal: true },
    });
    const sales = new Map<string, { qty: number; revenue: number }>();
    for (const l of lines) {
      const s = sales.get(l.itemId) ?? { qty: 0, revenue: 0 };
      s.qty += l.quantity;
      s.revenue += D(l.lineTotal);
      sales.set(l.itemId, s);
    }
    const result = classifyMenu(
      items.map((it) => ({
        itemId: it.id,
        name: it.name,
        category: it.category.name,
        qty: sales.get(it.id)?.qty ?? 0,
        revenue: sales.get(it.id)?.revenue ?? 0,
        listPrice: D(it.price),
        foodCost: Math.round(it.recipe.reduce((s, r) => s + D(r.quantity) * D(r.material.costPerUnit), 0) * 100) / 100,
        hasRecipe: it.recipe.length > 0,
      })),
    );
    const counts: Record<MenuClass, number> = { STAR: 0, PLOWHORSE: 0, PUZZLE: 0, DOG: 0 };
    for (const r of result.rows) counts[r.class] += 1;
    return { from, to, categories, ...result, counts };
  }
}
