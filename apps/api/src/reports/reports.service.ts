import { ForbiddenException, Injectable } from "@nestjs/common";
import type {
  AuthUser,
  BreakdownRowDto,
  CustomReportDto,
  CustomReportInput,
  DayEndReportDto,
  FraudReportDto,
  ItemSalesRowDto,
  OutletKpiDto,
  ReportBreakdownDto,
  ReportOverviewDto,
  SalesPointDto,
  TaxSummaryDto,
} from "@petpooja/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const N = (d: Prisma.Decimal | number) => (typeof d === "number" ? d : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  UPI: "UPI",
  WALLET: "Wallet",
  OTHER: "Other",
};
const ORDER_TYPE_LABELS: Record<string, string> = {
  DINE_IN: "Dine-in",
  TAKEAWAY: "Takeaway",
  DELIVERY: "Delivery",
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  private range(from: string, to: string) {
    return { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) };
  }

  private toRows(map: Map<string, { amount: number; count: number }>, labels: Record<string, string>): BreakdownRowDto[] {
    const total = [...map.values()].reduce((s, v) => s + v.amount, 0);
    return [...map.entries()]
      .map(([key, v]) => ({
        key,
        label: labels[key] ?? key,
        amount: round2(v.amount),
        count: v.count,
        share: total > 0 ? v.amount / total : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
  }

  async overview(user: AuthUser, outletId: string, from: string, to: string): Promise<ReportOverviewDto> {
    this.assertOutlet(user, outletId);
    const range = this.range(from, to);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: range },
      select: { total: true, taxAmount: true, discountAmount: true, createdAt: true },
    });
    const gross = orders.reduce((s, o) => s + N(o.total), 0);
    const tax = orders.reduce((s, o) => s + N(o.taxAmount), 0);
    const discounts = orders.reduce((s, o) => s + N(o.discountAmount), 0);

    // Daily series, gap-filled across the range.
    const byDay = new Map<string, { sales: number; orders: number }>();
    for (const o of orders) {
      const k = localDay(o.createdAt);
      const cur = byDay.get(k) ?? { sales: 0, orders: 0 };
      cur.sales += N(o.total);
      cur.orders += 1;
      byDay.set(k, cur);
    }
    const series: SalesPointDto[] = [];
    for (let d = new Date(range.gte); d <= range.lte; d.setDate(d.getDate() + 1)) {
      const k = localDay(d);
      const v = byDay.get(k) ?? { sales: 0, orders: 0 };
      series.push({ date: k, sales: round2(v.sales), orders: v.orders });
    }

    const newCustomers = await this.prisma.customer.count({
      where: { tenantId: user.tenantId, outletId, createdAt: range },
    });

    return {
      from,
      to,
      grossSales: round2(gross),
      netSales: round2(gross - tax),
      orders: orders.length,
      avgOrderValue: orders.length ? round2(gross / orders.length) : 0,
      taxCollected: round2(tax),
      discountsGiven: round2(discounts),
      newCustomers,
      series,
    };
  }

  async breakdown(user: AuthUser, outletId: string, from: string, to: string): Promise<ReportBreakdownDto> {
    this.assertOutlet(user, outletId);
    const range = this.range(from, to);
    const orderWhere = { outletId, tenantId: user.tenantId, status: "SETTLED", createdAt: range };

    const orders = await this.prisma.order.findMany({
      where: orderWhere,
      select: { id: true, orderType: true, total: true, subtotal: true, discountAmount: true, taxAmount: true },
    });
    const orderIds = orders.map((o) => o.id);

    // Payments
    const payments = await this.prisma.orderPayment.findMany({
      where: { orderId: { in: orderIds } },
      select: { mode: true, amount: true },
    });
    const payMap = new Map<string, { amount: number; count: number }>();
    for (const p of payments) {
      const cur = payMap.get(p.mode) ?? { amount: 0, count: 0 };
      cur.amount += N(p.amount);
      cur.count += 1;
      payMap.set(p.mode, cur);
    }

    // Order types
    const typeMap = new Map<string, { amount: number; count: number }>();
    for (const o of orders) {
      const cur = typeMap.get(o.orderType) ?? { amount: 0, count: 0 };
      cur.amount += N(o.total);
      cur.count += 1;
      typeMap.set(o.orderType, cur);
    }

    // Items + categories
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: { in: orderIds } },
      select: { itemId: true, itemName: true, quantity: true, lineTotal: true },
    });
    const itemIds = [...new Set(items.map((i) => i.itemId))];
    const itemRows = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, category: { select: { name: true } } },
    });
    const categoryByItem = new Map(itemRows.map((i) => [i.id, i.category?.name ?? "Uncategorised"]));

    const catMap = new Map<string, { amount: number; count: number }>();
    const itemAgg = new Map<string, ItemSalesRowDto>();
    for (const it of items) {
      const category = categoryByItem.get(it.itemId) ?? "Uncategorised";
      const cat = catMap.get(category) ?? { amount: 0, count: 0 };
      cat.amount += N(it.lineTotal);
      cat.count += it.quantity;
      catMap.set(category, cat);

      const row = itemAgg.get(it.itemName) ?? { itemName: it.itemName, category, qty: 0, revenue: 0 };
      row.qty += it.quantity;
      row.revenue += N(it.lineTotal);
      itemAgg.set(it.itemName, row);
    }

    const taxable = orders.reduce((s, o) => s + (N(o.subtotal) - N(o.discountAmount)), 0);
    const totalTax = orders.reduce((s, o) => s + N(o.taxAmount), 0);
    const tax: TaxSummaryDto = {
      taxableValue: round2(taxable),
      cgst: round2(totalTax / 2),
      sgst: round2(totalTax / 2),
      totalTax: round2(totalTax),
    };

    return {
      payments: this.toRows(payMap, PAYMENT_LABELS),
      orderTypes: this.toRows(typeMap, ORDER_TYPE_LABELS),
      categories: this.toRows(
        new Map([...catMap.entries()]),
        Object.fromEntries([...catMap.keys()].map((k) => [k, k])),
      ),
      topItems: [...itemAgg.values()]
        .map((r) => ({ ...r, revenue: round2(r.revenue) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 12),
      tax,
    };
  }

  /** Flexible builder: group settled sales by a chosen dimension for a chosen metric. */
  async custom(user: AuthUser, outletId: string, input: CustomReportInput): Promise<CustomReportDto> {
    this.assertOutlet(user, outletId);
    const range = this.range(input.from, input.to);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: range },
      select: {
        id: true,
        orderType: true,
        total: true,
        createdAt: true,
        payments: { select: { mode: true, amount: true } },
        items: { select: { itemId: true, itemName: true, quantity: true, lineTotal: true } },
      },
    });

    // Category needs an item→category lookup.
    let categoryByItem = new Map<string, string>();
    if (input.dimension === "category") {
      const itemIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.itemId)))];
      const rows = await this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, category: { select: { name: true } } },
      });
      categoryByItem = new Map(rows.map((i) => [i.id, i.category?.name ?? "Uncategorised"]));
    }

    type Acc = { label: string; revenue: number; quantity: number; orders: Set<string> };
    const groups = new Map<string, Acc>();
    const bucket = (key: string, label: string) => {
      let g = groups.get(key);
      if (!g) {
        g = { label, revenue: 0, quantity: 0, orders: new Set() };
        groups.set(key, g);
      }
      return g;
    };

    const itemLevel = input.dimension === "item" || input.dimension === "category";
    for (const o of orders) {
      const orderQty = o.items.reduce((s, i) => s + i.quantity, 0);
      if (itemLevel) {
        for (const it of o.items) {
          const key = input.dimension === "item" ? it.itemName : (categoryByItem.get(it.itemId) ?? "Uncategorised");
          const g = bucket(key, key);
          g.revenue += N(it.lineTotal);
          g.quantity += it.quantity;
          g.orders.add(o.id);
        }
      } else {
        let key: string;
        let label: string;
        if (input.dimension === "orderType") {
          key = o.orderType;
          label = ORDER_TYPE_LABELS[o.orderType] ?? o.orderType;
        } else if (input.dimension === "paymentMode") {
          const primary = [...o.payments].sort((a, b) => N(b.amount) - N(a.amount))[0];
          key = primary?.mode ?? "NONE";
          label = PAYMENT_LABELS[key] ?? key;
        } else if (input.dimension === "hour") {
          key = String(o.createdAt.getHours()).padStart(2, "0");
          label = `${key}:00`;
        } else {
          key = localDay(o.createdAt);
          label = key;
        }
        const g = bucket(key, label);
        g.revenue += N(o.total);
        g.quantity += orderQty;
        g.orders.add(o.id);
      }
    }

    const value = (g: Acc) =>
      input.metric === "revenue" ? round2(g.revenue) : input.metric === "quantity" ? g.quantity : g.orders.size;
    const raw = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, value: value(g) }));
    const total = raw.reduce((s, r) => s + r.value, 0);
    const chronological = input.dimension === "hour" || input.dimension === "day";
    const rows = raw
      .map((r) => ({ ...r, share: total > 0 ? r.value / total : 0 }))
      .sort((a, b) => (chronological ? a.key.localeCompare(b.key) : b.value - a.value));

    return {
      from: input.from,
      to: input.to,
      dimension: input.dimension,
      metric: input.metric,
      unit: input.metric === "revenue" ? "currency" : "count",
      rows,
      total: round2(total),
    };
  }

  async dayEnd(user: AuthUser, outletId: string, date: string): Promise<DayEndReportDto> {
    this.assertOutlet(user, outletId);
    const range = this.range(date, date);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: range },
      select: { id: true, orderType: true, total: true, taxAmount: true, discountAmount: true, billNumber: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const cancelledOrders = await this.prisma.order.count({
      where: { tenantId: user.tenantId, outletId, status: "CANCELLED", createdAt: range },
    });
    const gross = orders.reduce((s, o) => s + N(o.total), 0);
    const tax = orders.reduce((s, o) => s + N(o.taxAmount), 0);
    const discounts = orders.reduce((s, o) => s + N(o.discountAmount), 0);

    const payments = await this.prisma.orderPayment.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: { mode: true, amount: true },
    });
    const payMap = new Map<string, { amount: number; count: number }>();
    for (const p of payments) {
      const cur = payMap.get(p.mode) ?? { amount: 0, count: 0 };
      cur.amount += N(p.amount);
      cur.count += 1;
      payMap.set(p.mode, cur);
    }
    const typeMap = new Map<string, { amount: number; count: number }>();
    for (const o of orders) {
      const cur = typeMap.get(o.orderType) ?? { amount: 0, count: 0 };
      cur.amount += N(o.total);
      cur.count += 1;
      typeMap.set(o.orderType, cur);
    }

    return {
      date,
      orders: orders.length,
      cancelledOrders,
      gross: round2(gross),
      net: round2(gross - tax),
      discounts: round2(discounts),
      cgst: round2(tax / 2),
      sgst: round2(tax / 2),
      firstBill: orders[0]?.billNumber ?? null,
      lastBill: orders[orders.length - 1]?.billNumber ?? null,
      payments: this.toRows(payMap, PAYMENT_LABELS),
      orderTypes: this.toRows(typeMap, ORDER_TYPE_LABELS),
    };
  }

  async fraud(user: AuthUser, outletId: string, from: string, to: string): Promise<FraudReportDto> {
    this.assertOutlet(user, outletId);
    const range = this.range(from, to);
    const cancelled = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "CANCELLED", createdAt: range },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const discounted = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", discountAmount: { gt: 0 }, createdAt: range },
      orderBy: { discountAmount: "desc" },
      take: 50,
    });
    const map = (o: (typeof cancelled)[number]) => ({
      billNumber: o.billNumber,
      orderType: o.orderType as FraudReportDto["cancelled"][number]["orderType"],
      total: N(o.total),
      discountAmount: N(o.discountAmount),
      couponCode: o.couponCode,
      status: o.status as FraudReportDto["cancelled"][number]["status"],
      createdAt: o.createdAt.toISOString(),
    });
    return {
      cancelledCount: cancelled.length,
      discountedCount: discounted.length,
      discountedValue: round2(discounted.reduce((s, o) => s + N(o.discountAmount), 0)),
      cancelled: cancelled.map(map),
      discounted: discounted.map(map),
    };
  }

  async outletKpis(user: AuthUser, from: string, to: string): Promise<OutletKpiDto[]> {
    const range = this.range(from, to);
    const outlets = await this.prisma.outlet.findMany({
      where: { tenantId: user.tenantId, id: { in: user.outletIds } },
      orderBy: { name: "asc" },
    });
    const result: OutletKpiDto[] = [];
    for (const o of outlets) {
      const orders = await this.prisma.order.findMany({
        where: { outletId: o.id, status: "SETTLED", createdAt: range },
        select: { total: true },
      });
      const gross = orders.reduce((s, x) => s + N(x.total), 0);
      result.push({
        outletId: o.id,
        outletName: o.name,
        grossSales: round2(gross),
        orders: orders.length,
        avgOrderValue: orders.length ? round2(gross / orders.length) : 0,
      });
    }
    return result;
  }
}
