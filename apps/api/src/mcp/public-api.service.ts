import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { hasPermission, type AuthUser } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { ReportsService } from "../reports/reports.service";
import { emitDomainEvent } from "../events/domain-events";

const N = (v: unknown) => Number(v);
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface OrderListQuery {
  outletId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The curated, integration-facing read/write surface shared by the REST public
 * API (/ext/…) and the MCP server. Every method takes the caller principal (a
 * user session or an API key), checks the permission it needs, and scopes to
 * the caller's tenant and outlets.
 */
@Injectable()
export class PublicApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  require(user: AuthUser, perm: string) {
    if (!hasPermission(user.permissions, perm)) throw new ForbiddenException(`This credential lacks the ${perm} permission`);
  }

  private outlet(user: AuthUser, outletId: string | undefined): string {
    const id = outletId ?? (user.outletIds.length === 1 ? user.outletIds[0] : undefined);
    if (!id) throw new BadRequestException("outletId is required (this credential can see several outlets)");
    if (!user.outletIds.includes(id)) throw new ForbiddenException("No access to outlet");
    return id;
  }

  private range(from?: string, to?: string) {
    const t = to && DATE.test(to) ? to : ymd(new Date());
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - 6);
    const f = from && DATE.test(from) ? from : ymd(fallback);
    return { from: f, to: t };
  }

  async outlets(user: AuthUser) {
    const rows = await this.prisma.outlet.findMany({
      where: { tenantId: user.tenantId, id: { in: user.outletIds } },
      select: { id: true, name: true, address: true, gstin: true },
      orderBy: { name: "asc" },
    });
    return rows;
  }

  async listOrders(user: AuthUser, q: OrderListQuery) {
    this.require(user, "orders.view");
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
    const outletIds = q.outletId ? [this.outlet(user, q.outletId)] : user.outletIds;
    const { from, to } = this.range(q.from, q.to);
    const rows = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        outletId: { in: outletIds },
        deletedAt: null,
        ...(q.status ? { status: q.status.toUpperCase() } : {}),
        createdAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true, outletId: true, billNumber: true, orderType: true, status: true, customerName: true,
        subtotal: true, discountAmount: true, taxAmount: true, total: true, createdAt: true,
        _count: { select: { items: true } },
      },
    });
    const items = rows.slice(0, limit).map(({ _count, ...o }) => ({
      ...o,
      subtotal: N(o.subtotal),
      discountAmount: N(o.discountAmount),
      taxAmount: N(o.taxAmount),
      total: N(o.total),
      createdAt: o.createdAt.toISOString(),
      lineCount: _count.items,
    }));
    return { from, to, items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  async getOrder(user: AuthUser, orderId: string) {
    this.require(user, "orders.view");
    const o = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId, outletId: { in: user.outletIds } },
      include: {
        items: { select: { itemId: true, itemName: true, variationName: true, quantity: true, unitPrice: true, lineTotal: true, prepStatus: true, note: true } },
        payments: { select: { mode: true, amount: true, createdAt: true } },
        kots: { select: { id: true, kotNumber: true, createdAt: true } },
      },
    });
    if (!o) throw new NotFoundException("Order not found");
    return {
      id: o.id,
      outletId: o.outletId,
      billNumber: o.billNumber,
      orderType: o.orderType,
      status: o.status,
      customerName: o.customerName,
      couponCode: o.couponCode,
      subtotal: N(o.subtotal),
      discountAmount: N(o.discountAmount),
      taxAmount: N(o.taxAmount),
      total: N(o.total),
      createdAt: o.createdAt.toISOString(),
      items: o.items.map((i) => ({ ...i, unitPrice: N(i.unitPrice), lineTotal: N(i.lineTotal) })),
      payments: o.payments.map((p) => ({ mode: p.mode, amount: N(p.amount), createdAt: p.createdAt.toISOString() })),
      kots: o.kots.map((k) => ({ ...k, createdAt: k.createdAt.toISOString() })),
    };
  }

  async salesSummary(user: AuthUser, outletId: string | undefined, from?: string, to?: string) {
    this.require(user, "reports.view");
    const r = this.range(from, to);
    return this.reports.overview(user, this.outlet(user, outletId), r.from, r.to);
  }

  async topItems(user: AuthUser, outletId: string | undefined, from?: string, to?: string, limit = 10) {
    this.require(user, "reports.view");
    const r = this.range(from, to);
    const b = await this.reports.breakdown(user, this.outlet(user, outletId), r.from, r.to);
    return { from: r.from, to: r.to, items: b.topItems.slice(0, Math.min(Math.max(limit, 1), 12)) };
  }

  async items(user: AuthUser, outletId: string | undefined, search?: string) {
    this.require(user, "menu.stock");
    const id = this.outlet(user, outletId);
    const rows = await this.prisma.item.findMany({
      where: {
        tenantId: user.tenantId,
        outletId: id,
        deletedAt: null,
        ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
      },
      select: { id: true, name: true, shortCode: true, price: true, isVeg: true, inStock: true, category: { select: { name: true } } },
      orderBy: { name: "asc" },
      take: 200,
    });
    return rows.map((i) => ({ id: i.id, name: i.name, shortCode: i.shortCode, category: i.category.name, price: N(i.price), isVeg: i.isVeg, inStock: i.inStock }));
  }

  /** 86 (or un-86) an item; same effect as the POS/KDS toggle. */
  async setAvailability(user: AuthUser, outletId: string | undefined, itemId: string, inStock: boolean) {
    this.require(user, "menu.stock");
    const id = this.outlet(user, outletId);
    const owned = await this.prisma.item.findFirst({ where: { id: itemId, tenantId: user.tenantId, outletId: id, deletedAt: null }, select: { id: true } });
    if (!owned) throw new NotFoundException("Item not found");
    const item = await this.prisma.item.update({ where: { id: owned.id }, data: { inStock } });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.apiKeyId ? null : user.id,
        action: "ITEM_AVAILABILITY_SET",
        entity: "item",
        entityId: item.id,
        data: { inStock, via: user.apiKeyId ? `api_key:${user.apiKeyId}` : "user" },
      },
    });
    this.realtime.notifyOutlet(id);
    emitDomainEvent("item.availability", user.tenantId, id, { itemId: item.id, name: item.name, inStock: item.inStock });
    return { id: item.id, name: item.name, inStock: item.inStock };
  }

  async stock(user: AuthUser, outletId: string | undefined, lowOnly = false) {
    this.require(user, "inventory.manage");
    const id = this.outlet(user, outletId);
    const rows = await this.prisma.rawMaterial.findMany({
      where: { tenantId: user.tenantId, outletId: id, deletedAt: null },
      select: { id: true, name: true, unit: true, stockQty: true, reorderLevel: true, costPerUnit: true },
      orderBy: { name: "asc" },
    });
    return rows
      .map((m) => ({
        id: m.id,
        name: m.name,
        unit: m.unit,
        stockQty: N(m.stockQty),
        reorderLevel: N(m.reorderLevel),
        costPerUnit: N(m.costPerUnit),
        lowStock: N(m.stockQty) <= N(m.reorderLevel),
      }))
      .filter((m) => !lowOnly || m.lowStock);
  }
}
