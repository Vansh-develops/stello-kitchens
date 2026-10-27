import { BadRequestException, Injectable } from "@nestjs/common";
import {
  backtestDaily,
  forecastAccuracy,
  forecastDaily,
  suggestReorderQty,
  type AuthUser,
  type ForecastAccuracyDto,
  type ForecastDto,
  type MaterialPlanningDto,
  type MaterialPlanningInput,
  type MaterialUnit,
  type SuggestionGroupDto,
  type SuggestionsDto,
  type SuggestionsToPosInput,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { D, assertOutlet, dayRange, localDay, round2, round3, round4 } from "./procurement.common";

const DAY = 86400000;
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

type ItemHistory = { itemId: string; name: string; history: number[]; recipe: { rawMaterialId: string; qty: number }[] };

/** Reorder/par levels, statistical demand forecasting and purchase suggestions. */
@Injectable()
export class PlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  // ---------- Reorder & par levels ----------

  async listPlanning(user: AuthUser, outletId: string): Promise<MaterialPlanningDto[]> {
    assertOutlet(user, outletId);
    const materials = await this.prisma.rawMaterial.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
      include: { planning: true },
    });
    return materials.map((m) => ({
      rawMaterialId: m.id,
      name: m.name,
      unit: m.unit as MaterialUnit,
      stockQty: D(m.stockQty),
      costPerUnit: D(m.costPerUnit),
      reorderLevel: D(m.reorderLevel),
      parLevel: m.planning?.parLevel == null ? null : D(m.planning.parLevel),
      category: m.planning?.category ?? null,
      preferredVendorId: m.planning?.preferredVendorId ?? null,
      leadTimeDays: m.planning?.leadTimeDays ?? null,
      minOrderQty: m.planning?.minOrderQty == null ? null : D(m.planning.minOrderQty),
      belowReorder: D(m.stockQty) <= D(m.reorderLevel),
    }));
  }

  async savePlanning(user: AuthUser, outletId: string, input: MaterialPlanningInput) {
    assertOutlet(user, outletId);
    const ids = [...new Set(input.rows.map((r) => r.rawMaterialId))];
    const count = await this.prisma.rawMaterial.count({
      where: { id: { in: ids }, tenantId: user.tenantId, outletId, deletedAt: null },
    });
    if (count !== ids.length) throw new BadRequestException("Unknown material");
    const vendorIds = [...new Set(input.rows.map((r) => r.preferredVendorId).filter((v): v is string => !!v))];
    if (vendorIds.length) {
      const vc = await this.prisma.vendor.count({
        where: { id: { in: vendorIds }, tenantId: user.tenantId, outletId, deletedAt: null },
      });
      if (vc !== vendorIds.length) throw new BadRequestException("Unknown vendor");
    }
    await this.prisma.$transaction(async (tx) => {
      for (const r of input.rows) {
        if (r.reorderLevel !== undefined) {
          await tx.rawMaterial.update({ where: { id: r.rawMaterialId }, data: { reorderLevel: r.reorderLevel } });
        }
        const data = {
          parLevel: r.parLevel,
          category: r.category === undefined ? undefined : r.category?.trim() || null,
          preferredVendorId: r.preferredVendorId,
          leadTimeDays: r.leadTimeDays,
          minOrderQty: r.minOrderQty,
        };
        const existing = await tx.materialPlanning.findFirst({ where: { rawMaterialId: r.rawMaterialId, tenantId: user.tenantId } });
        if (existing) await tx.materialPlanning.update({ where: { id: existing.id }, data });
        else {
          await tx.materialPlanning.create({
            data: {
              tenantId: user.tenantId,
              outletId,
              rawMaterialId: r.rawMaterialId,
              parLevel: r.parLevel ?? null,
              category: data.category ?? null,
              preferredVendorId: r.preferredVendorId ?? null,
              leadTimeDays: r.leadTimeDays ?? null,
              minOrderQty: r.minOrderQty ?? null,
            },
          });
        }
      }
    });
    return { updated: input.rows.length };
  }

  // ---------- Forecasting ----------

  /** Daily units sold per menu item over [start, start + days). Combo parents are skipped; their components count. */
  private async itemHistories(user: AuthUser, outletId: string, start: Date, days: number): Promise<ItemHistory[]> {
    const end = new Date(start.getTime() + days * DAY + DAY); // DST-safe upper bound; filtered by day key below
    const keys = dayRange(start, days);
    const index = new Map(keys.map((k, i) => [k, i]));
    const [orders, items] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          tenantId: user.tenantId,
          outletId,
          deletedAt: null,
          status: { not: "CANCELLED" },
          createdAt: { gte: start, lt: end },
        },
        select: {
          createdAt: true,
          items: { select: { itemId: true, quantity: true, comboId: true, isComboComponent: true } },
        },
      }),
      this.prisma.item.findMany({
        where: { tenantId: user.tenantId, outletId, deletedAt: null },
        include: { recipe: true },
      }),
    ]);
    const byItem = new Map<string, number[]>();
    for (const o of orders) {
      const i = index.get(localDay(o.createdAt));
      if (i === undefined) continue;
      for (const line of o.items) {
        if (line.comboId && !line.isComboComponent) continue;
        const h = byItem.get(line.itemId) ?? Array(days).fill(0);
        h[i] += line.quantity;
        byItem.set(line.itemId, h);
      }
    }
    return items
      .filter((it) => byItem.has(it.id))
      .map((it) => ({
        itemId: it.id,
        name: it.name,
        history: byItem.get(it.id)!,
        recipe: it.recipe.map((r) => ({ rawMaterialId: r.rawMaterialId, qty: D(r.quantity) })),
      }));
  }

  private today() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  private async lookback(user: AuthUser, outletId: string) {
    return (await this.purchaseOrders.getSettings(user, outletId)).lookbackDays;
  }

  /** Per-item and per-material daily forecast for the next `horizon` days (starting today). */
  async forecast(user: AuthUser, outletId: string, horizon: number): Promise<ForecastDto> {
    assertOutlet(user, outletId);
    const lookbackDays = await this.lookback(user, outletId);
    const today = this.today();
    const start = new Date(today);
    start.setDate(start.getDate() - lookbackDays);
    const histories = await this.itemHistories(user, outletId, start, lookbackDays);
    const firstDow = start.getDay();

    const items = histories.map((h) => {
      const f = forecastDaily(h.history, firstDow, horizon);
      return { ...h, f };
    });
    const materialF = new Map<string, number[]>();
    for (const it of items) {
      for (const r of it.recipe) {
        const cur = materialF.get(r.rawMaterialId) ?? Array(horizon).fill(0);
        it.f.forEach((v, d) => (cur[d] += v * r.qty));
        materialF.set(r.rawMaterialId, cur);
      }
    }
    const materials = await this.prisma.rawMaterial.findMany({
      where: { id: { in: [...materialF.keys()] }, tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
    });
    return {
      days: dayRange(today, horizon),
      lookbackDays,
      items: items
        .map((it) => ({
          itemId: it.itemId,
          name: it.name,
          avgDaily: round2(sum(it.history) / lookbackDays),
          forecast: it.f.map(round2),
          total: round2(sum(it.f)),
        }))
        .sort((a, b) => b.total - a.total),
      materials: materials.map((m) => {
        const f = materialF.get(m.id)!;
        const total = sum(f);
        const daily = total / horizon;
        return {
          rawMaterialId: m.id,
          name: m.name,
          unit: m.unit as MaterialUnit,
          onHand: D(m.stockQty),
          forecast: f.map(round3),
          total: round3(total),
          daysOfCover: daily > 0 ? Math.round((Math.max(0, D(m.stockQty)) / daily) * 10) / 10 : null,
        };
      }),
    };
  }

  /** Forecast vs actual: one-step-ahead backtest over the last `testDays` days (ending yesterday). */
  async accuracy(user: AuthUser, outletId: string, testDays: number): Promise<ForecastAccuracyDto> {
    assertOutlet(user, outletId);
    const lookbackDays = await this.lookback(user, outletId);
    const total = lookbackDays + testDays;
    const today = this.today();
    const start = new Date(today);
    start.setDate(start.getDate() - total);
    const histories = await this.itemHistories(user, outletId, start, total);
    const firstDow = start.getDay();
    const testStart = new Date(today);
    testStart.setDate(testStart.getDate() - testDays);
    const days = dayRange(testStart, testDays);

    const totals = { actual: Array(testDays).fill(0), forecast: Array(testDays).fill(0) };
    const matForecast = new Map<string, number[]>();
    const itemRows = histories.map((h) => {
      const bt = backtestDaily(h.history, firstDow, testDays);
      const offset = testDays - bt.length; // fewer than 7 training days → shorter backtest
      bt.forEach((p, i) => {
        totals.actual[i + offset] += p.actual;
        totals.forecast[i + offset] += p.forecast;
        for (const r of h.recipe) {
          const cur = matForecast.get(r.rawMaterialId) ?? Array(testDays).fill(0);
          cur[i + offset] += p.forecast * r.qty;
          matForecast.set(r.rawMaterialId, cur);
        }
      });
      const s = forecastAccuracy(bt);
      return { itemId: h.itemId, name: h.name, actual: s.actual, forecast: round2(s.forecast), accuracy: s.accuracy };
    });

    // Actual material consumption from the ledger over the test window.
    const index = new Map(days.map((k, i) => [k, i]));
    const moves = await this.prisma.stockMovement.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        type: "CONSUMPTION",
        createdAt: { gte: testStart, lt: new Date(today.getTime() + DAY) },
      },
      select: { rawMaterialId: true, quantity: true, createdAt: true },
    });
    const matActual = new Map<string, number[]>();
    for (const m of moves) {
      const i = index.get(localDay(m.createdAt));
      if (i === undefined) continue;
      const cur = matActual.get(m.rawMaterialId) ?? Array(testDays).fill(0);
      cur[i] += -D(m.quantity);
      matActual.set(m.rawMaterialId, cur);
    }
    const matIds = [...new Set([...matForecast.keys(), ...matActual.keys()])];
    const materials = await this.prisma.rawMaterial.findMany({
      where: { id: { in: matIds }, tenantId: user.tenantId, outletId },
      orderBy: { name: "asc" },
    });
    const pairs = totals.actual.map((a, i) => ({ actual: a, forecast: totals.forecast[i] }));
    return {
      days,
      totals: { actual: totals.actual.map(round2), forecast: totals.forecast.map(round2) },
      summary: forecastAccuracy(pairs),
      items: itemRows.sort((a, b) => b.actual - a.actual).slice(0, 40),
      materials: materials.map((m) => {
        const a = matActual.get(m.id) ?? Array(testDays).fill(0);
        const f = matForecast.get(m.id) ?? Array(testDays).fill(0);
        const s = forecastAccuracy(a.map((v, i) => ({ actual: v, forecast: f[i] })));
        return {
          rawMaterialId: m.id,
          name: m.name,
          unit: m.unit as MaterialUnit,
          actual: s.actual,
          forecast: s.forecast,
          accuracy: s.accuracy,
        };
      }),
    };
  }

  // ---------- Suggested purchase ----------

  async suggestions(user: AuthUser, outletId: string): Promise<SuggestionsDto> {
    assertOutlet(user, outletId);
    const settings = await this.purchaseOrders.getSettings(user, outletId);
    const materials = await this.prisma.rawMaterial.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null, isSemiFinished: false },
      orderBy: { name: "asc" },
      include: { planning: true },
    });
    const leadOf = (m: (typeof materials)[number]) => m.planning?.leadTimeDays ?? settings.leadDays;
    const horizon = Math.max(0, ...materials.map(leadOf)) + settings.coverDays;
    const fc = await this.forecast(user, outletId, horizon);
    const fcBy = new Map(fc.materials.map((m) => [m.rawMaterialId, m.forecast]));

    // Outstanding quantity on live POs, in material units.
    const openLines = await this.prisma.purchaseOrderLine.findMany({
      where: {
        tenantId: user.tenantId,
        purchaseOrder: { outletId, status: { in: ["APPROVED", "SENT", "PARTIALLY_RECEIVED"] } },
      },
    });
    const onOrder = new Map<string, number>();
    for (const l of openLines) {
      const pending = Math.max(0, D(l.orderedQty) - D(l.receivedQty)) * D(l.unitFactor);
      onOrder.set(l.rawMaterialId, (onOrder.get(l.rawMaterialId) ?? 0) + pending);
    }

    // Vendor of record: preferred, else whoever supplied it last.
    const lastReceipts = await this.prisma.stockMovement.findMany({
      where: { tenantId: user.tenantId, outletId, type: "RECEIPT", vendorId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: { rawMaterialId: true, vendorId: true, unitCost: true },
    });
    const lastBy = new Map<string, { vendorId: string; unitCost: number }>();
    const lastByPair = new Map<string, number>();
    for (const r of lastReceipts) {
      if (!lastBy.has(r.rawMaterialId)) lastBy.set(r.rawMaterialId, { vendorId: r.vendorId!, unitCost: D(r.unitCost) });
      const key = `${r.rawMaterialId}:${r.vendorId}`;
      if (!lastByPair.has(key)) lastByPair.set(key, D(r.unitCost));
    }
    const vendors = await this.prisma.vendor.findMany({ where: { tenantId: user.tenantId, outletId, deletedAt: null } });
    const vendorName = new Map(vendors.map((v) => [v.id, v.name]));

    const groups = new Map<string, SuggestionGroupDto>();
    for (const m of materials) {
      const lead = leadOf(m);
      const f = fcBy.get(m.id) ?? Array(horizon).fill(0);
      const usageLead = sum(f.slice(0, lead));
      const usageCover = sum(f.slice(lead, lead + settings.coverDays));
      const s = suggestReorderQty({
        onHand: D(m.stockQty),
        onOrder: onOrder.get(m.id) ?? 0,
        reorderLevel: D(m.reorderLevel),
        parLevel: m.planning?.parLevel == null ? null : D(m.planning.parLevel),
        usageLead,
        usageCover,
        minOrderQty: m.planning?.minOrderQty == null ? null : D(m.planning.minOrderQty),
      });
      if (s.suggested <= 0) continue;
      const preferred = m.planning?.preferredVendorId;
      const vendorId =
        preferred && vendorName.has(preferred)
          ? preferred
          : lastBy.get(m.id) && vendorName.has(lastBy.get(m.id)!.vendorId)
            ? lastBy.get(m.id)!.vendorId
            : null;
      const rate = round4((vendorId && lastByPair.get(`${m.id}:${vendorId}`)) || D(m.costPerUnit));
      const key = vendorId ?? "";
      const g = groups.get(key) ?? {
        vendorId,
        vendorName: vendorId ? vendorName.get(vendorId)! : "No vendor assigned",
        lines: [],
        total: 0,
      };
      g.lines.push({
        rawMaterialId: m.id,
        name: m.name,
        unit: m.unit as MaterialUnit,
        onHand: D(m.stockQty),
        onOrder: round3(onOrder.get(m.id) ?? 0),
        reorderLevel: D(m.reorderLevel),
        parLevel: m.planning?.parLevel == null ? null : D(m.planning.parLevel),
        usageLead: round3(usageLead),
        usageCover: round3(usageCover),
        avgDailyUsage: horizon > 0 ? round3(sum(f) / horizon) : 0,
        projectedAtArrival: s.projectedAtArrival,
        suggestedQty: s.suggested,
        rate,
        amount: round2(s.suggested * rate),
        reason: s.reason,
      });
      g.total = round2(g.total + s.suggested * rate);
      groups.set(key, g);
    }
    return {
      coverDays: settings.coverDays,
      leadDays: settings.leadDays,
      groups: [...groups.values()].sort((a, b) => (a.vendorId ? 0 : 1) - (b.vendorId ? 0 : 1) || b.total - a.total),
    };
  }

  /** Turn (edited) suggestion lines into one draft PO per vendor. */
  async createPurchaseOrders(user: AuthUser, outletId: string, input: SuggestionsToPosInput) {
    assertOutlet(user, outletId);
    const byVendor = new Map<string, SuggestionsToPosInput["lines"]>();
    for (const l of input.lines) byVendor.set(l.vendorId, [...(byVendor.get(l.vendorId) ?? []), l]);
    const created: { id: string; poNumber: string; vendorId: string }[] = [];
    for (const [vendorId, lines] of byVendor) {
      const po = await this.purchaseOrders.create(user, outletId, {
        vendorId,
        note: "Raised from purchase suggestions",
        lines: lines.map((l) => ({ rawMaterialId: l.rawMaterialId, quantity: l.quantity, rate: l.rate, taxRate: 0 })),
      });
      created.push({ ...po, vendorId });
    }
    return created;
  }
}
