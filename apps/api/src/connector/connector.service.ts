import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AggregatorOrderDto,
  AuthUser,
  ConnectorIngestInput,
  ConnectorIngestResult,
  MenuPushRowDto,
  ReconciliationRowDto,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "../orders/orders.service";

// Aggregator platform → the sales-channel name that carries its pricing/maps.
const PLATFORM_CHANNEL: Record<string, string> = {
  ZOMATO: "Zomato",
  SWIGGY: "Swiggy",
  ONDC: "ONDC",
  URBANPIPER: "UrbanPiper",
};

@Injectable()
export class ConnectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  /** Ingest a normalised aggregator order: map external items, create the POS order. */
  async ingest(input: ConnectorIngestInput): Promise<ConnectorIngestResult> {
    const outlet = await this.prisma.outlet.findUnique({ where: { id: input.outletId } });
    if (!outlet) throw new NotFoundException("Unknown outlet");

    // Idempotency: a re-delivered webhook must not double-create.
    const existing = await this.prisma.aggregatorOrder.findUnique({
      where: { platform_externalOrderId: { platform: input.platform, externalOrderId: input.externalOrderId } },
    });
    if (existing) {
      return {
        aggregatorOrderId: existing.id,
        orderId: existing.orderId,
        kotNumber: null,
        matched: 0,
        unmatched: Array.isArray(existing.unmatchedItems) ? (existing.unmatchedItems as string[]) : [],
        duplicate: true,
      };
    }

    const channelName = PLATFORM_CHANNEL[input.platform];
    const channel = await this.prisma.channel.findFirst({
      where: { outletId: input.outletId, name: channelName },
    });

    // Map external item ids → internal via aggregator_menu_maps for this channel.
    const matched: { itemId: string; quantity: number }[] = [];
    const unmatched: string[] = [];
    if (channel) {
      const maps = await this.prisma.aggregatorMenuMap.findMany({
        where: { channelId: channel.id, externalId: { in: input.items.map((i) => i.externalItemId) } },
      });
      const byExternal = new Map(maps.map((m) => [m.externalId, m.itemId]));
      for (const line of input.items) {
        const itemId = byExternal.get(line.externalItemId);
        if (itemId) matched.push({ itemId, quantity: line.quantity });
        else unmatched.push(line.externalItemId);
      }
    } else {
      unmatched.push(...input.items.map((i) => i.externalItemId));
    }

    let orderId: string | null = null;
    let kotNumber: number | null = null;
    if (matched.length > 0) {
      const result = await this.orders.ingestAggregatorOrder({
        tenantId: outlet.tenantId,
        outletId: input.outletId,
        items: matched.map((m) => ({ itemId: m.itemId, quantity: m.quantity, addonIds: [] })),
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhoneMasked ?? null,
      });
      orderId = result.orderId;
      kotNumber = result.kotNumber;
    }

    const agg = await this.prisma.aggregatorOrder.create({
      data: {
        tenantId: outlet.tenantId,
        outletId: input.outletId,
        platform: input.platform,
        externalOrderId: input.externalOrderId,
        orderId,
        // Accepted the moment we successfully relay it into the kitchen.
        status: orderId ? "ACCEPTED" : "RECEIVED",
        customerName: input.customerName ?? null,
        customerPhoneMasked: input.customerPhoneMasked ?? null,
        orderValue: input.orderValue,
        unmatchedItems: unmatched.length ? unmatched : Prisma.JsonNull,
        rawPayload: (input.rawPayload as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    return { aggregatorOrderId: agg.id, orderId, kotNumber, matched: matched.length, unmatched, duplicate: false };
  }

  async updateStatus(platform: string, externalOrderId: string, status: string) {
    const agg = await this.prisma.aggregatorOrder.findUnique({
      where: { platform_externalOrderId: { platform, externalOrderId } },
    });
    if (!agg) throw new NotFoundException("Aggregator order not found");
    await this.prisma.aggregatorOrder.update({ where: { id: agg.id }, data: { status } });
    return { id: agg.id, status };
  }

  /** Menu payload to push to an aggregator: mapped items + channel price + stock. */
  async menuPush(platform: string, outletId: string): Promise<MenuPushRowDto[]> {
    const channel = await this.prisma.channel.findFirst({
      where: { outletId, name: PLATFORM_CHANNEL[platform] },
    });
    if (!channel) throw new BadRequestException(`No ${platform} channel configured for this outlet`);
    const maps = await this.prisma.aggregatorMenuMap.findMany({
      where: { channelId: channel.id },
      include: { item: { include: { channelPrices: { where: { channelId: channel.id } } } } },
    });
    return maps
      .filter((m) => m.item.deletedAt === null)
      .map((m) => ({
        externalId: m.externalId,
        itemName: m.item.name,
        price: m.item.channelPrices[0] ? Number(m.item.channelPrices[0].price) : Number(m.item.price),
        inStock: m.item.inStock,
      }));
  }

  async stockPush(platform: string, outletId: string): Promise<string[]> {
    const rows = await this.menuPush(platform, outletId);
    return rows.filter((r) => !r.inStock).map((r) => r.externalId);
  }

  // ---------- Dashboard-facing reads (JWT) ----------

  async listOrders(user: AuthUser, outletId: string): Promise<AggregatorOrderDto[]> {
    if (!user.outletIds.includes(outletId)) throw new NotFoundException("No access to outlet");
    const orders = await this.prisma.aggregatorOrder.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Build an item summary from the linked internal order.
    const internalIds = orders.map((o) => o.orderId).filter((x): x is string => !!x);
    const internal = await this.prisma.order.findMany({
      where: { id: { in: internalIds } },
      include: { items: true },
    });
    const summaryById = new Map(
      internal.map((o) => [
        o.id,
        o.items.map((i) => `${i.quantity}× ${i.itemName}`).join(", "),
      ]),
    );

    return orders.map((o) => ({
      id: o.id,
      platform: o.platform as AggregatorOrderDto["platform"],
      externalOrderId: o.externalOrderId,
      orderId: o.orderId,
      status: o.status as AggregatorOrderDto["status"],
      customerName: o.customerName,
      orderValue: Number(o.orderValue),
      unmatchedItems: Array.isArray(o.unmatchedItems) ? (o.unmatchedItems as string[]) : [],
      itemSummary: o.orderId ? (summaryById.get(o.orderId) ?? "") : "(unmatched — not relayed)",
      createdAt: o.createdAt.toISOString(),
    }));
  }

  async reconciliation(user: AuthUser, outletId: string): Promise<ReconciliationRowDto[]> {
    if (!user.outletIds.includes(outletId)) throw new NotFoundException("No access to outlet");
    const orders = await this.prisma.aggregatorOrder.findMany({
      where: { tenantId: user.tenantId, outletId },
    });
    const agg = new Map<string, ReconciliationRowDto>();
    for (const o of orders) {
      const row =
        agg.get(o.platform) ??
        ({ platform: o.platform as ReconciliationRowDto["platform"], orders: 0, gross: 0, delivered: 0, rejected: 0 });
      row.orders += 1;
      row.gross += Number(o.orderValue);
      if (o.status === "DELIVERED") row.delivered += 1;
      if (o.status === "REJECTED" || o.status === "CANCELLED") row.rejected += 1;
      agg.set(o.platform, row);
    }
    return [...agg.values()].map((r) => ({ ...r, gross: Math.round(r.gross * 100) / 100 }));
  }
}
