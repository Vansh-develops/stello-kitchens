import { ForbiddenException, Injectable } from "@nestjs/common";
import type {
  AreaDto,
  AuthUser,
  MenuCategoryDto,
  SyncPullDto,
  SyncPushInput,
  SyncPushResultRowDto,
  SyncSnapshotDto,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "../orders/orders.service";

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Reference data an edge device caches so it can bill with the WAN down. */
  async snapshot(user: AuthUser, outletId: string): Promise<SyncSnapshotDto> {
    this.assertOutlet(user, outletId);
    const [categories, areas] = await Promise.all([
      this.prisma.menuCategory.findMany({
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
      }),
      this.prisma.area.findMany({
        where: { tenantId: user.tenantId, outletId },
        include: { tables: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
    ]);

    const menu: MenuCategoryDto[] = categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      combos: [], // combos are validated online; the offline edge doesn't sell them
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

    const areaDtos: AreaDto[] = areas.map((a) => ({
      id: a.id,
      name: a.name,
      tables: a.tables.map((t) => ({ id: t.id, name: t.name, seats: t.seats, occupiedByOrderId: null })),
    }));

    const outlet = await this.prisma.outlet.findUniqueOrThrow({
      where: { id: outletId },
      select: { brand: { select: { themeId: true } } },
    });

    return {
      menu,
      areas: areaDtos,
      themeId: outlet.brand.themeId,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Apply an outbox batch from a device. Idempotent and insert-once per order: the
   * first delivery of a (deviceId, clientId) is applied and every later delivery is
   * reported as a duplicate — a terminal offline order is never overwritten by a
   * re-sync. See apps/edge/README.md for the offline consistency model.
   */
  async push(user: AuthUser, input: SyncPushInput): Promise<SyncPushResultRowDto[]> {
    this.assertOutlet(user, input.outletId);
    const results: SyncPushResultRowDto[] = [];
    for (const order of input.orders) {
      try {
        const res = await this.orders.applySyncedOrder({
          tenantId: user.tenantId,
          outletId: input.outletId,
          deviceId: input.deviceId,
          order,
        });
        results.push({ clientId: order.clientId, serverId: res.serverId, billNumber: res.billNumber, status: res.status });
      } catch (err) {
        results.push({
          clientId: order.clientId,
          serverId: null,
          billNumber: null,
          status: "error",
          message: err instanceof Error ? err.message : "apply failed",
        });
      }
    }
    return results;
  }

  /** Orders changed on the server since a cursor (cross-terminal awareness). */
  async pull(user: AuthUser, outletId: string, since?: string): Promise<SyncPullDto> {
    this.assertOutlet(user, outletId);
    const sinceDate = since ? new Date(since) : new Date(0);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, updatedAt: { gt: sinceDate } },
      orderBy: { updatedAt: "asc" },
      take: 200,
    });
    const cursor = orders.length ? orders[orders.length - 1].updatedAt.toISOString() : new Date().toISOString();
    return {
      orders: orders.map((o) => ({
        id: o.id,
        deviceId: o.deviceId,
        clientId: o.clientId,
        billNumber: o.billNumber,
        status: o.status as SyncPullDto["orders"][number]["status"],
        orderType: o.orderType as SyncPullDto["orders"][number]["orderType"],
        total: Number(o.total),
        updatedAt: o.updatedAt.toISOString(),
      })),
      cursor,
    };
  }
}
