import { z } from "zod";
import type { MaterialUnit } from "./types";

// =====================================================================
// Procurement, stock control & insights — schemas, DTOs and the pure
// business math (PO state machine, unit conversion, demand forecasting,
// reorder suggestions, menu engineering). Pure functions live here so the
// API and the dashboard agree on every number, and so they are unit-tested
// without a database.
// =====================================================================

const ProcUnit = z.enum(["KG", "G", "L", "ML", "PCS"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---------- Units ----------

/**
 * How many `to` units are in one `from` unit (KG→G = 1000), or null when the
 * units measure different things (mass vs volume vs count).
 */
export function unitFactor(from: MaterialUnit, to: MaterialUnit): number | null {
  if (from === to) return 1;
  const pairs: Record<string, number> = { "KG>G": 1000, "G>KG": 0.001, "L>ML": 1000, "ML>L": 0.001 };
  return pairs[`${from}>${to}`] ?? null;
}

/** Units a material can be purchased in (its own unit plus the compatible one). */
export function purchaseUnitsFor(unit: MaterialUnit): MaterialUnit[] {
  return (["KG", "G", "L", "ML", "PCS"] as MaterialUnit[]).filter((u) => unitFactor(u, unit) !== null);
}

// ---------- Purchase-order state machine ----------

export type PoStatus =
  | "DRAFT"
  | "APPROVED"
  | "SENT"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CLOSED"
  | "CANCELLED";
export type PoAction = "approve" | "send" | "cancel" | "close";

const PO_TRANSITIONS: Record<PoAction, { from: PoStatus[]; to: PoStatus }> = {
  approve: { from: ["DRAFT"], to: "APPROVED" },
  send: { from: ["APPROVED"], to: "SENT" },
  // Once goods have arrived a PO can only be closed (short-closed), never cancelled.
  cancel: { from: ["DRAFT", "APPROVED", "SENT"], to: "CANCELLED" },
  close: { from: ["PARTIALLY_RECEIVED", "RECEIVED"], to: "CLOSED" },
};

/** The status an action moves a PO to, or null if the action is not allowed from `status`. */
export function nextPoStatus(status: PoStatus, action: PoAction): PoStatus | null {
  const t = PO_TRANSITIONS[action];
  return t.from.includes(status) ? t.to : null;
}

export function poActionsFor(status: PoStatus): PoAction[] {
  return (Object.keys(PO_TRANSITIONS) as PoAction[]).filter((a) => nextPoStatus(status, a) !== null);
}

/** Goods can be received once a PO is approved, until it is fully received/closed. */
export function canReceivePo(status: PoStatus): boolean {
  return status === "APPROVED" || status === "SENT" || status === "PARTIALLY_RECEIVED";
}

/** Lines are editable only while the PO is a draft. */
export function canEditPo(status: PoStatus): boolean {
  return status === "DRAFT";
}

/** Status after a receipt, given each line's ordered and (new) received quantity. */
export function statusAfterReceipt(lines: { orderedQty: number; receivedQty: number }[]): PoStatus {
  const done = lines.every((l) => l.receivedQty + 1e-9 >= l.orderedQty);
  return done ? "RECEIVED" : "PARTIALLY_RECEIVED";
}

/** Largest quantity still receivable on a line under an over-receipt tolerance (percent). */
export function maxReceivable(orderedQty: number, receivedQty: number, tolerancePct: number): number {
  return Math.max(0, round3(orderedQty * (1 + tolerancePct / 100) - receivedQty));
}

/** Line money in integer paise: taxable base and tax, so PO totals add up exactly. */
export function lineAmountsPaise(qty: number, rate: number, taxRatePct: number): { basePaise: number; taxPaise: number } {
  const basePaise = Math.round(qty * rate * 100);
  return { basePaise, taxPaise: Math.round((basePaise * taxRatePct) / 100) };
}

export function priceVariance(poRate: number, actualRate: number, qty: number) {
  const perUnit = actualRate - poRate;
  return {
    perUnit: round4(perUnit),
    amount: Math.round(perUnit * qty * 100) / 100,
    pct: poRate > 0 ? Math.round((perUnit / poRate) * 1000) / 10 : null,
  };
}

// ---------- Demand forecasting (statistical, no external AI) ----------
//
// "Holt-Winters-lite": day-of-week seasonal indices (shrunk towards 1 when a
// weekday has few samples), then Holt's linear smoothing with a damped trend on
// the de-seasonalised series, re-seasonalised for each forecast day. Fully
// deterministic: the same history always produces the same forecast.

export interface ForecastOptions {
  /** Level smoothing (0..1). Higher reacts faster to recent days. */
  alpha?: number;
  /** Trend smoothing (0..1). */
  beta?: number;
  /** Trend damping (0..1). 0 disables the trend. */
  phi?: number;
  /** Pseudo-observations pulling each weekday index towards 1. */
  shrink?: number;
}

export interface DemandModel {
  level: number;
  trend: number;
  phi: number;
  /** Seasonal index per JS weekday (0 = Sunday). Averages to 1. */
  seasonal: number[];
}

const DEFAULTS: Required<ForecastOptions> = { alpha: 0.3, beta: 0.1, phi: 0.9, shrink: 0.5 };

/**
 * Fit a model to a daily history (oldest → newest, consecutive days).
 * `firstDow` is the weekday (0 = Sunday) of `history[0]`.
 */
export function fitDemandModel(history: number[], firstDow: number, options: ForecastOptions = {}): DemandModel {
  const o = { ...DEFAULTS, ...options };
  const flat: DemandModel = { level: 0, trend: 0, phi: o.phi, seasonal: [1, 1, 1, 1, 1, 1, 1] };
  if (history.length === 0) return flat;
  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  if (mean <= 0) return flat;

  // Seasonal ratios against a centred 7-day moving average (classical
  // decomposition), so a growing/shrinking trend isn't mistaken for weekday mix.
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 3; i + 3 < history.length; i++) {
    let window = 0;
    for (let k = i - 3; k <= i + 3; k++) window += history[k];
    const cma = window / 7;
    if (cma <= 0) continue;
    const d = (firstDow + i) % 7;
    sums[d] += history[i] / cma;
    counts[d] += 1;
  }
  let seasonal = sums.map((s, d) => {
    const raw = counts[d] ? s / counts[d] : 1;
    return (counts[d] * raw + o.shrink) / (counts[d] + o.shrink);
  });
  const avg = seasonal.reduce((s, v) => s + v, 0) / 7;
  seasonal = seasonal.map((s) => Math.max(s / avg, 0.05));

  const de = history.map((v, i) => v / seasonal[(firstDow + i) % 7]);
  let level = de[0];
  let trend = 0;
  for (let i = 1; i < de.length; i++) {
    const prev = level;
    level = o.alpha * de[i] + (1 - o.alpha) * (prev + o.phi * trend);
    trend = o.beta * (level - prev) + (1 - o.beta) * o.phi * trend;
  }
  return { level, trend, phi: o.phi, seasonal };
}

/** Project `horizon` days; `startDow` is the weekday of the first projected day. */
export function projectDemand(model: DemandModel, startDow: number, horizon: number): number[] {
  const out: number[] = [];
  let damp = 0;
  let pow = 1;
  for (let h = 1; h <= horizon; h++) {
    pow *= model.phi;
    damp += pow;
    const base = model.level + damp * model.trend;
    out.push(Math.max(0, base * model.seasonal[(startDow + h - 1) % 7]));
  }
  return out;
}

/** Fit + project in one call: the `horizon` days right after the history. */
export function forecastDaily(
  history: number[],
  firstDow: number,
  horizon: number,
  options?: ForecastOptions,
): number[] {
  const model = fitDemandModel(history, firstDow, options);
  return projectDemand(model, (firstDow + history.length) % 7, horizon);
}

/**
 * One-step-ahead backtest over the last `testDays` of `history`: each day is
 * forecast using only the days before it. Needs at least 7 training days.
 */
export function backtestDaily(
  history: number[],
  firstDow: number,
  testDays: number,
  options?: ForecastOptions,
): { actual: number; forecast: number }[] {
  const out: { actual: number; forecast: number }[] = [];
  const start = Math.max(7, history.length - testDays);
  for (let i = start; i < history.length; i++) {
    const [f] = forecastDaily(history.slice(0, i), firstDow, 1, options);
    out.push({ actual: history[i], forecast: f });
  }
  return out;
}

/** WAPE (sum |a−f| / sum a), bias (sum f − a) / sum a, and accuracy = 1 − WAPE. */
export function forecastAccuracy(pairs: { actual: number; forecast: number }[]) {
  const actual = pairs.reduce((s, p) => s + p.actual, 0);
  const forecast = pairs.reduce((s, p) => s + p.forecast, 0);
  const absErr = pairs.reduce((s, p) => s + Math.abs(p.actual - p.forecast), 0);
  const wape = actual > 0 ? absErr / actual : null;
  return {
    actual: round3(actual),
    forecast: round3(forecast),
    wape: wape === null ? null : Math.round(wape * 1000) / 1000,
    bias: actual > 0 ? Math.round(((forecast - actual) / actual) * 1000) / 1000 : null,
    accuracy: wape === null ? null : Math.max(0, Math.round((1 - wape) * 1000) / 1000),
  };
}

// ---------- Reorder suggestions ----------

export interface ReorderInput {
  onHand: number;
  /** Outstanding quantity on approved/sent POs, in material units. */
  onOrder: number;
  /** Safety stock: never plan to dip below this. */
  reorderLevel: number;
  /** Optional par (order-up-to) level. */
  parLevel: number | null;
  /** Forecast consumption during the supplier lead time. */
  usageLead: number;
  /** Forecast consumption over the cover window after delivery. */
  usageCover: number;
  /** Round the suggestion up to a multiple of this pack size. */
  minOrderQty?: number | null;
}

/**
 * Order enough that, after the lead time, stock covers the forecast for the
 * cover window plus the reorder (safety) level — or reaches par, whichever is
 * higher.
 */
export function suggestReorderQty(i: ReorderInput) {
  const projectedAtArrival = i.onHand + i.onOrder - i.usageLead;
  const target = Math.max(i.parLevel ?? 0, i.usageCover + i.reorderLevel);
  let suggested = Math.max(0, target - projectedAtArrival);
  if (suggested > 0 && i.minOrderQty && i.minOrderQty > 0) {
    suggested = Math.ceil(suggested / i.minOrderQty - 1e-9) * i.minOrderQty;
  }
  let reason = "Stock covers the forecast";
  if (suggested > 0) {
    if (i.onHand <= i.reorderLevel) reason = "At or below reorder level";
    else if ((i.parLevel ?? 0) > i.usageCover + i.reorderLevel) reason = "Top up to par level";
    else reason = "Forecast demand exceeds projected stock";
  }
  return {
    projectedAtArrival: round3(projectedAtArrival),
    target: round3(target),
    suggested: round3(suggested),
    reason,
  };
}

// ---------- Menu engineering (Kasavana & Smith) ----------

export type MenuClass = "STAR" | "PLOWHORSE" | "PUZZLE" | "DOG";

export interface MenuEngineeringInputRow {
  itemId: string;
  name: string;
  category: string;
  qty: number;
  revenue: number;
  listPrice: number;
  /** Recipe food cost per unit at current weighted-average material cost. */
  foodCost: number;
  hasRecipe: boolean;
}

export interface MenuEngineeringRow extends MenuEngineeringInputRow {
  avgPrice: number;
  contributionMargin: number;
  totalMargin: number;
  foodCostPct: number | null;
  mixPct: number;
  highPopularity: boolean;
  highMargin: boolean;
  class: MenuClass;
  hint: string;
}

/**
 * Popularity is "high" when an item's share of units sold is at least 70% of
 * an equal share (0.7 / N). Margin is "high" when its contribution margin is at
 * least the sales-weighted average contribution margin.
 */
export function classifyMenu(rows: MenuEngineeringInputRow[]) {
  const n = rows.length;
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const popularityThreshold = n > 0 ? 0.7 / n : 0;
  const withCm = rows.map((r) => {
    const avgPrice = r.qty > 0 ? r.revenue / r.qty : r.listPrice;
    return { r, avgPrice, cm: avgPrice - r.foodCost };
  });
  const avgCm =
    totalQty > 0
      ? withCm.reduce((s, x) => s + x.cm * x.r.qty, 0) / totalQty
      : n > 0
        ? withCm.reduce((s, x) => s + x.cm, 0) / n
        : 0;

  const out: MenuEngineeringRow[] = withCm.map(({ r, avgPrice, cm }) => {
    const mixPct = totalQty > 0 ? r.qty / totalQty : 0;
    const highPopularity = totalQty > 0 && mixPct >= popularityThreshold - 1e-12;
    const highMargin = cm >= avgCm - 1e-9;
    const cls: MenuClass = highPopularity ? (highMargin ? "STAR" : "PLOWHORSE") : highMargin ? "PUZZLE" : "DOG";
    const foodCostPct = avgPrice > 0 ? Math.round((r.foodCost / avgPrice) * 1000) / 10 : null;
    return {
      ...r,
      avgPrice: round2(avgPrice),
      contributionMargin: round2(cm),
      totalMargin: round2(cm * r.qty),
      foodCostPct,
      mixPct: Math.round(mixPct * 10000) / 10000,
      highPopularity,
      highMargin,
      class: cls,
      hint: menuHint(cls, { foodCostPct, hasRecipe: r.hasRecipe, cm, avgCm }),
    };
  });
  return {
    rows: out.sort((a, b) => b.totalMargin - a.totalMargin),
    popularityThreshold: Math.round(popularityThreshold * 10000) / 10000,
    avgContributionMargin: round2(avgCm),
    totalQty,
  };
}

function menuHint(
  cls: MenuClass,
  x: { foodCostPct: number | null; hasRecipe: boolean; cm: number; avgCm: number },
): string {
  const noRecipe = x.hasRecipe ? "" : " No recipe is mapped, so food cost (and this class) may be overstated.";
  const fc = x.foodCostPct !== null ? ` Food cost is ${x.foodCostPct}% of price.` : "";
  switch (cls) {
    case "STAR":
      return `Protect it: keep quality and prime menu placement; a small price rise is usually tolerated.${noRecipe}`;
    case "PLOWHORSE":
      return `Popular but thin margin (₹${round2(x.avgCm - x.cm)} under average).${fc} Trim portion or recipe cost, raise price slightly, or bundle with high-margin add-ons.${noRecipe}`;
    case "PUZZLE":
      return `Profitable but under-ordered: move it to a prime spot, rename or describe it better, and have staff recommend it.${noRecipe}`;
    case "DOG":
      return `Low popularity and below-average margin: rework, reprice or retire it to simplify the menu and the kitchen.${noRecipe}`;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ---------- Schemas ----------

export const ProcurementVendorSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(20).nullable().optional(),
  email: z.string().email().max(120).nullable().optional(),
  gstin: z.string().max(15).nullable().optional(),
  address: z.string().max(240).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
});
export type ProcurementVendorInput = z.infer<typeof ProcurementVendorSchema>;

export const PoLineInputSchema = z.object({
  rawMaterialId: z.string().min(1),
  quantity: z.number().positive(),
  /** Purchase unit; defaults to the material's own unit. Must be convertible. */
  unit: ProcUnit.optional(),
  rate: z.number().min(0),
  taxRate: z.number().min(0).max(28).default(0),
});
export type PoLineInput = z.infer<typeof PoLineInputSchema>;

export const CreatePurchaseOrderSchema = z.object({
  vendorId: z.string().min(1),
  expectedDate: isoDate.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  lines: z.array(PoLineInputSchema).min(1).max(200),
});
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;

export const UpdatePurchaseOrderSchema = CreatePurchaseOrderSchema.partial();
export type UpdatePurchaseOrderInput = z.infer<typeof UpdatePurchaseOrderSchema>;

export const PoActionSchema = z.object({
  action: z.enum(["approve", "send", "cancel", "close"]),
  reason: z.string().max(240).optional(),
});
export type PoActionInput = z.infer<typeof PoActionSchema>;

export const ReceiveGrnSchema = z.object({
  invoiceNo: z.string().max(60).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  lines: z
    .array(
      z.object({
        poLineId: z.string().min(1),
        quantity: z.number().min(0),
        /** Actual invoiced rate per purchase unit; defaults to the PO rate. */
        rate: z.number().min(0).optional(),
      }),
    )
    .min(1),
  /** Book a supplier bill for this receipt (needs the vendor invoice number). */
  createBill: z.boolean().default(false),
  billDueDate: isoDate.nullable().optional(),
});
export type ReceiveGrnInput = z.infer<typeof ReceiveGrnSchema>;

export const SupplierBillSchema = z.object({
  vendorId: z.string().min(1),
  billNumber: z.string().min(1).max(60),
  billDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  amount: z.number().positive(),
  purchaseOrderId: z.string().nullable().optional(),
  goodsReceiptId: z.string().nullable().optional(),
  note: z.string().max(240).nullable().optional(),
});
export type SupplierBillInput = z.infer<typeof SupplierBillSchema>;

export const SupplierPaymentSchema = z.object({
  vendorId: z.string().min(1),
  amount: z.number().positive(),
  mode: z.enum(["CASH", "BANK", "UPI", "CHEQUE", "OTHER"]),
  reference: z.string().max(80).nullable().optional(),
  paidAt: isoDate.nullable().optional(),
  note: z.string().max(240).nullable().optional(),
  /** Explicit allocation; omitted = settle oldest open bills first. */
  allocations: z.array(z.object({ billId: z.string().min(1), amount: z.number().positive() })).optional(),
});
export type SupplierPaymentInput = z.infer<typeof SupplierPaymentSchema>;

export const CreateStockCountSchema = z.object({
  scope: z.enum(["FULL", "CATEGORY"]).default("FULL"),
  category: z.string().max(60).nullable().optional(),
  note: z.string().max(240).nullable().optional(),
});
export type CreateStockCountInput = z.infer<typeof CreateStockCountSchema>;

export const StockCountEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        lineId: z.string().min(1),
        countedQty: z.number().min(0).nullable(),
        note: z.string().max(120).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type StockCountEntriesInput = z.infer<typeof StockCountEntriesSchema>;

export const MaterialPlanningSchema = z.object({
  rows: z
    .array(
      z.object({
        rawMaterialId: z.string().min(1),
        reorderLevel: z.number().min(0).optional(),
        parLevel: z.number().min(0).nullable().optional(),
        category: z.string().max(60).nullable().optional(),
        preferredVendorId: z.string().nullable().optional(),
        leadTimeDays: z.number().int().min(0).max(60).nullable().optional(),
        minOrderQty: z.number().min(0).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type MaterialPlanningInput = z.infer<typeof MaterialPlanningSchema>;

export const ProcurementSettingsSchema = z.object({
  overReceiptPct: z.number().min(0).max(100),
  priceVarianceAlertPct: z.number().min(0).max(100),
  coverDays: z.number().int().min(1).max(60),
  leadDays: z.number().int().min(0).max(30),
  lookbackDays: z.number().int().min(14).max(120),
});
export type ProcurementSettingsInput = z.infer<typeof ProcurementSettingsSchema>;

export const SuggestionsToPosSchema = z.object({
  lines: z
    .array(
      z.object({
        rawMaterialId: z.string().min(1),
        vendorId: z.string().min(1),
        quantity: z.number().positive(),
        rate: z.number().min(0),
      }),
    )
    .min(1)
    .max(500),
});
export type SuggestionsToPosInput = z.infer<typeof SuggestionsToPosSchema>;

// ---------- DTOs ----------

export interface ProcurementVendorDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  address: string | null;
  paymentTermsDays: number | null;
}

export interface PurchaseOrderLineDto {
  id: string;
  rawMaterialId: string;
  materialName: string;
  materialUnit: MaterialUnit;
  unit: MaterialUnit;
  unitFactor: number;
  orderedQty: number;
  receivedQty: number;
  pendingQty: number;
  rate: number;
  taxRate: number;
  amount: number;
  taxAmount: number;
}

export interface PurchaseOrderSummaryDto {
  id: string;
  poNumber: string;
  status: PoStatus;
  vendorId: string;
  vendorName: string;
  expectedDate: string | null;
  total: number;
  lineCount: number;
  receivedPct: number;
  createdAt: string;
}

export interface GoodsReceiptLineDto {
  id: string;
  poLineId: string;
  materialName: string;
  unit: MaterialUnit;
  quantity: number;
  rate: number;
  poRate: number;
  taxRate: number;
  lineTotal: number;
  priceVariance: number;
  priceVariancePct: number | null;
}

export interface GoodsReceiptDto {
  id: string;
  grnNumber: string;
  purchaseOrderId: string;
  poNumber: string;
  vendorName: string;
  invoiceNo: string | null;
  note: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  varianceAmount: number;
  receivedAt: string;
  lines: GoodsReceiptLineDto[];
}

export interface PurchaseOrderDto extends PurchaseOrderSummaryDto {
  note: string | null;
  subtotal: number;
  taxAmount: number;
  vendor: ProcurementVendorDto;
  outlet: { name: string; address: string | null; gstin: string | null };
  lines: PurchaseOrderLineDto[];
  receipts: GoodsReceiptDto[];
  allowedActions: PoAction[];
  approvedAt: string | null;
  sentAt: string | null;
  overReceiptPct: number;
}

export interface PriceHistoryRowDto {
  receivedAt: string;
  vendorId: string;
  vendorName: string;
  rawMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  /** Per material unit. */
  unitCost: number;
  poUnitCost: number;
  quantity: number;
  grnNumber: string;
}

export interface SupplierBillDto {
  id: string;
  vendorId: string;
  vendorName: string;
  billNumber: string;
  billDate: string;
  dueDate: string | null;
  amount: number;
  paidAmount: number;
  outstanding: number;
  status: "OPEN" | "PARTIAL" | "PAID" | "VOID";
  overdue: boolean;
  poNumber: string | null;
  grnNumber: string | null;
}

export interface SupplierPaymentDto {
  id: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  unallocated: number;
  mode: string;
  reference: string | null;
  paidAt: string;
  allocations: { billId: string; billNumber: string; amount: number }[];
}

export interface VendorPayableDto {
  vendorId: string;
  vendorName: string;
  billed: number;
  paid: number;
  outstanding: number;
  overdue: number;
  credit: number;
  openBills: number;
  oldestDue: string | null;
}

export interface StockCountSummaryDto {
  id: string;
  countNumber: string;
  scope: "FULL" | "CATEGORY";
  category: string | null;
  status: "COUNTING" | "SUBMITTED" | "POSTED" | "CANCELLED";
  startedAt: string;
  postedAt: string | null;
  lineCount: number;
  countedCount: number;
  varianceValue: number;
}

export interface StockCountLineDto {
  id: string;
  rawMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  category: string | null;
  expectedQty: number;
  countedQty: number | null;
  varianceQty: number | null;
  varianceValue: number | null;
  unitCost: number;
  /** Net ledger movement on this material since the count was frozen. */
  movedSinceFreeze: number;
  note: string | null;
}

export interface StockCountDto extends StockCountSummaryDto {
  note: string | null;
  lines: StockCountLineDto[];
  shrinkageValue: number;
  surplusValue: number;
}

export interface MaterialPlanningDto {
  rawMaterialId: string;
  name: string;
  unit: MaterialUnit;
  stockQty: number;
  costPerUnit: number;
  reorderLevel: number;
  parLevel: number | null;
  category: string | null;
  preferredVendorId: string | null;
  leadTimeDays: number | null;
  minOrderQty: number | null;
  belowReorder: boolean;
}

export type ProcurementSettingsDto = ProcurementSettingsInput;

export interface SuggestionLineDto {
  rawMaterialId: string;
  name: string;
  unit: MaterialUnit;
  onHand: number;
  onOrder: number;
  reorderLevel: number;
  parLevel: number | null;
  usageLead: number;
  usageCover: number;
  avgDailyUsage: number;
  projectedAtArrival: number;
  suggestedQty: number;
  rate: number;
  amount: number;
  reason: string;
}

export interface SuggestionGroupDto {
  vendorId: string | null;
  vendorName: string;
  lines: SuggestionLineDto[];
  total: number;
}

export interface SuggestionsDto {
  coverDays: number;
  leadDays: number;
  groups: SuggestionGroupDto[];
}

export interface ForecastDto {
  days: string[];
  lookbackDays: number;
  items: { itemId: string; name: string; avgDaily: number; forecast: number[]; total: number }[];
  materials: {
    rawMaterialId: string;
    name: string;
    unit: MaterialUnit;
    onHand: number;
    forecast: number[];
    total: number;
    /** Days the current stock lasts at forecast usage (null = no usage). */
    daysOfCover: number | null;
  }[];
}

export interface ForecastAccuracyDto {
  days: string[];
  totals: { actual: number[]; forecast: number[] };
  summary: ReturnType<typeof forecastAccuracy>;
  items: { itemId: string; name: string; actual: number; forecast: number; accuracy: number | null }[];
  materials: {
    rawMaterialId: string;
    name: string;
    unit: MaterialUnit;
    actual: number;
    forecast: number;
    accuracy: number | null;
  }[];
}

export interface MenuEngineeringDto {
  from: string;
  to: string;
  categories: { id: string; name: string }[];
  popularityThreshold: number;
  avgContributionMargin: number;
  totalQty: number;
  counts: Record<MenuClass, number>;
  rows: MenuEngineeringRow[];
}
