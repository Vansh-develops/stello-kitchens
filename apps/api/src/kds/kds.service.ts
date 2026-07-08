import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdvanceTicketInput,
  AuthUser,
  KdsStockItemDto,
  KdsTicketDto,
  StationDto,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

// How long a readied ticket lingers in the "Ready" column before dropping off.
const READY_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class KdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async stations(user: AuthUser, outletId: string): Promise<StationDto[]> {
    this.assertOutlet(user, outletId);
    const stations = await this.prisma.station.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { sortOrder: "asc" },
    });
    return stations.map((s) => ({
      id: s.id,
      name: s.name,
      prepMinutes: s.prepMinutes,
      sortOrder: s.sortOrder,
    }));
  }

  async tickets(user: AuthUser, outletId: string): Promise<KdsTicketDto[]> {
    this.assertOutlet(user, outletId);

    const readyCutoff = new Date(Date.now() - READY_WINDOW_MS);
    const items = await this.prisma.orderItem.findMany({
      where: {
        order: { outletId, tenantId: user.tenantId, status: { not: "CANCELLED" } },
        kotId: { not: null },
        OR: [{ prepStatus: { not: "READY" } }, { preppedAt: { gte: readyCutoff } }],
      },
      include: {
        kot: true,
        order: { include: { table: true } },
        addons: true,
      },
    });

    const stations = await this.prisma.station.findMany({
      where: { tenantId: user.tenantId, outletId },
    });
    const stationMap = new Map(stations.map((s) => [s.id, s]));

    // Group into station-tickets keyed by (kot, station).
    const tickets = new Map<string, KdsTicketDto>();
    for (const item of items) {
      if (!item.kot) continue;
      const stationId = item.stationId ?? null;
      const key = `${item.kotId}::${stationId ?? "none"}`;
      const station = stationId ? stationMap.get(stationId) : undefined;
      let ticket = tickets.get(key);
      if (!ticket) {
        ticket = {
          key,
          kotId: item.kotId!,
          kotNumber: item.kot.kotNumber,
          orderId: item.orderId,
          orderType: item.order.orderType as KdsTicketDto["orderType"],
          tableName: item.order.table?.name ?? null,
          stationId,
          stationName: station?.name ?? "Kitchen",
          prepMinutes: station?.prepMinutes ?? 10,
          status: item.prepStatus as KdsTicketDto["status"],
          createdAt: item.kot.createdAt.toISOString(),
          preppedAt: item.preppedAt ? item.preppedAt.toISOString() : null,
          items: [],
        };
        tickets.set(key, ticket);
      }
      ticket.items.push({
        id: item.id,
        itemId: item.itemId,
        name: item.itemName,
        variationName: item.variationName,
        addonNames: item.addons.map((a) => a.name),
        quantity: item.quantity,
        note: item.note,
      });
      // A ticket's items advance together, so any one reflects the group status.
      ticket.status = item.prepStatus as KdsTicketDto["status"];
      if (item.preppedAt) ticket.preppedAt = item.preppedAt.toISOString();
    }

    // Oldest first — the kitchen works the top of the rail.
    return [...tickets.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async advance(user: AuthUser, kotId: string, input: AdvanceTicketInput): Promise<{ ok: true }> {
    const kot = await this.prisma.kot.findUnique({ where: { id: kotId } });
    if (!kot || kot.tenantId !== user.tenantId) throw new NotFoundException("KOT not found");
    this.assertOutlet(user, kot.outletId);

    const preppedAt = input.toStatus === "READY" ? new Date() : null;
    const result = await this.prisma.orderItem.updateMany({
      where: {
        kotId,
        stationId: input.stationId, // null matches null (uncategorised)
      },
      data: { prepStatus: input.toStatus, preppedAt },
    });
    if (result.count === 0) throw new BadRequestException("No items for that station on this KOT");

    this.realtime.notifyOutlet(kot.outletId);
    return { ok: true };
  }

  async stock(user: AuthUser, outletId: string): Promise<KdsStockItemDto[]> {
    this.assertOutlet(user, outletId);
    const items = await this.prisma.item.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, inStock: true },
    });
    return items.map((i) => ({ itemId: i.id, name: i.name, inStock: i.inStock }));
  }
}
