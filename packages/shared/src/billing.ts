// Billing controls: service charge, round-off, split/merge/transfer, parked carts
// and item time-window availability. The money math lives here (integer paise,
// like money.ts) so the API, the POS preview and tests all use one formula.
import { z } from "zod";
import { fromPaise, toPaise, type MoneyLine, type OrderTotals } from "./money";
import { ComboOrderInputSchema, OrderItemInputSchema, OrderType } from "./schemas";

// ---------- Money ----------

export interface BillOptions {
  /** Pre-tax discount in rupees (clamped to the subtotal). */
  discountRupees: number;
  /** Service charge on the post-discount food value; null/0% = none. */
  serviceCharge?: { percent: number; taxable: boolean } | null;
  /** Round the payable total to the nearest whole rupee. */
  roundOff?: boolean;
}

export interface BillTotals extends OrderTotals {
  serviceChargeAmount: number;
  /** Signed adjustment (−0.49 … +0.50) that makes `total` a whole rupee. */
  roundOff: number;
  totalBeforeRoundOff: number;
}

/**
 * The full bill in integer paise. With no service charge and no round-off this
 * is exactly `computeOrderTotals` (the offline edge formula), so existing bills
 * and offline parity are unchanged.
 *
 * - Service charge = percent of the taxable food value (subtotal − discount).
 * - A taxable service charge follows the principal supply: it is taxed at the
 *   bill's blended line rate, folded into the single tax rounding.
 * - Round-off is recorded separately; payments must equal the rounded total.
 */
export function computeBill(lines: MoneyLine[], opts: BillOptions): BillTotals {
  const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const discountPaise = Math.min(Math.max(0, toPaise(opts.discountRupees)), subtotalPaise);
  const taxablePaise = subtotalPaise - discountPaise;
  const sc = opts.serviceCharge;
  const scPaise = sc && sc.percent > 0 ? Math.round((taxablePaise * sc.percent) / 100) : 0;
  const rawTaxPaise = lines.reduce((s, l) => s + (l.lineTotalPaise * l.taxRatePercent) / 100, 0);
  const taxBasePaise = taxablePaise + (sc?.taxable ? scPaise : 0);
  const taxPaise = subtotalPaise > 0 ? Math.round((rawTaxPaise * taxBasePaise) / subtotalPaise) : 0;
  const preRoundPaise = taxablePaise + scPaise + taxPaise;
  const totalPaise = opts.roundOff ? Math.round(preRoundPaise / 100) * 100 : preRoundPaise;
  return {
    subtotal: fromPaise(subtotalPaise),
    discountAmount: fromPaise(discountPaise),
    serviceChargeAmount: fromPaise(scPaise),
    taxAmount: fromPaise(taxPaise),
    roundOff: fromPaise(totalPaise - preRoundPaise),
    totalBeforeRoundOff: fromPaise(preRoundPaise),
    total: fromPaise(totalPaise),
  };
}

/**
 * Split `totalPaise` across `weights` proportionally (largest-remainder), so the
 * parts are whole paise and always sum back to the total exactly. Ties go to
 * the earlier index; all-zero weights split evenly.
 */
export function allocatePaise(totalPaise: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const w = sum > 0 ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const wSum = sum > 0 ? sum : weights.length;
  const exact = w.map((x) => (totalPaise * x) / wSum);
  const parts = exact.map((x) => Math.floor(x));
  let rest = totalPaise - parts.reduce((s, p) => s + p, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k].i] += 1;
  return parts;
}

/**
 * Equal split of each line across `parts` checks. Every line's paise are divided
 * evenly; the leftover paise rotate across checks line by line so the check
 * subtotals never differ by more than one paisa. Returns [check][line] paise.
 */
export function splitLinesEqually(linePaise: number[], parts: number): number[][] {
  const out = Array.from({ length: parts }, () => linePaise.map(() => 0));
  let offset = 0;
  linePaise.forEach((p, li) => {
    const base = Math.floor(p / parts);
    const rem = p - base * parts;
    for (let c = 0; c < parts; c++) out[c][li] = base;
    for (let k = 0; k < rem; k++) out[(offset + k) % parts][li] += 1;
    offset = (offset + rem) % parts;
  });
  return out;
}

// ---------- Item availability windows ----------

/** "HH:MM" → minutes after midnight, or null when unset/invalid. */
export function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Is an item with window [start, end) sellable at `minutes` past local midnight?
 * Unset bounds are open; start > end wraps midnight (e.g. 22:00–02:00).
 */
export function isWithinWindow(start: string | null | undefined, end: string | null | undefined, minutes: number): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null && e === null) return true;
  const from = s ?? 0;
  const to = e ?? 24 * 60;
  if (from === to) return true; // degenerate window = all day
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export const DEFAULT_OUTLET_TIMEZONE = "Asia/Kolkata";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight at `date` in `timeZone` (falls back to IST). */
export function minutesInZone(date: Date, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_OUTLET_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function isItemAvailableAt(
  item: { availableStart?: string | null; availableEnd?: string | null },
  date: Date,
  timeZone: string,
): boolean {
  return isWithinWindow(item.availableStart, item.availableEnd, minutesInZone(date, timeZone));
}

// ---------- Schemas ----------

export const BillingSettingsSchema = z.object({
  serviceChargeEnabled: z.boolean(),
  serviceChargePercent: z.number().min(0).max(30).multipleOf(0.01),
  serviceChargeTaxable: z.boolean(),
  serviceChargeOrderTypes: z.array(OrderType).max(3),
  roundOffEnabled: z.boolean(),
  timezone: z.string().min(1).max(60).refine(isValidTimeZone, "Unknown time zone"),
});
export type BillingSettingsInput = z.infer<typeof BillingSettingsSchema>;

export const RemoveServiceChargeSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason").max(200),
});
export type RemoveServiceChargeInput = z.infer<typeof RemoveServiceChargeSchema>;

export const SettlePreviewSchema = z.object({
  discountAmount: z.number().min(0).optional(),
  couponCode: z.string().max(40).optional(),
  redeemPoints: z.number().int().min(0).optional(),
  customerPhone: z.string().max(20).optional(),
});
export type SettlePreviewInput = z.infer<typeof SettlePreviewSchema>;

const LineQtySchema = z.object({
  orderItemId: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type LineQtyInput = z.infer<typeof LineQtySchema>;

export const MergeOrdersSchema = z.object({
  sourceOrderIds: z.array(z.string().min(1)).min(1).max(10),
});
export type MergeOrdersInput = z.infer<typeof MergeOrdersSchema>;

// Omit `lines` to move the whole order to another table.
export const TransferOrderSchema = z.object({
  toTableId: z.string().min(1),
  lines: z.array(LineQtySchema).min(1).max(200).optional(),
});
export type TransferOrderInput = z.infer<typeof TransferOrderSchema>;

export const SplitOrderSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("EQUAL"),
    parts: z.number().int().min(2).max(20),
    discountAmount: z.number().min(0).optional(),
  }),
  z.object({
    mode: z.literal("ITEMS"),
    checks: z.array(z.object({ lines: z.array(LineQtySchema).min(1).max(200) })).min(2).max(20),
    discountAmount: z.number().min(0).optional(),
  }),
]);
export type SplitOrderInput = z.infer<typeof SplitOrderSchema>;

// A parked cart line: what will be punched on resume, plus display snapshot.
export const ParkedLineSchema = z.discriminatedUnion("kind", [
  OrderItemInputSchema.extend({
    kind: z.literal("item"),
    name: z.string().max(120),
    variationName: z.string().max(60).nullable().default(null),
    addonNames: z.array(z.string().max(60)).max(30).default([]),
    unitPrice: z.number().min(0),
  }),
  ComboOrderInputSchema.extend({
    kind: z.literal("combo"),
    name: z.string().max(120),
    componentNames: z.array(z.string().max(120)).max(30).default([]),
    unitPrice: z.number().min(0),
  }),
]);
export type ParkedLine = z.infer<typeof ParkedLineSchema>;

export const ParkCartSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    orderType: OrderType,
    tableId: z.string().optional(),
    orderId: z.string().optional(), // pending additions to a running order
    customerName: z.string().max(80).optional(),
    customerPhone: z.string().max(20).optional(),
    lines: z.array(ParkedLineSchema).max(200).default([]),
  })
  .refine((v) => v.lines.length > 0 || !!v.orderId, { message: "Nothing to park" });
export type ParkCartInput = z.infer<typeof ParkCartSchema>;

// ---------- DTOs ----------

export interface BillingSettingsDto extends BillingSettingsInput {
  outletId: string;
}

export interface BillPreviewDto {
  subtotal: number;
  discountAmount: number;
  couponDiscount: number;
  redeemDiscount: number;
  serviceChargeAmount: number;
  serviceChargePercent: number;
  serviceChargeTaxable: boolean;
  serviceChargeRemoved: boolean;
  taxAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
}

export interface ParkedCartDto {
  id: string;
  label: string;
  orderType: z.infer<typeof OrderType>;
  tableId: string | null;
  tableName: string | null;
  orderId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  lines: ParkedLine[];
  itemCount: number;
  amount: number;
  parkedBy: string | null;
  createdAt: string;
}
