import { z } from "zod";
import { OrderType, PaymentMode } from "./schemas";

// ---------- Offline edge POS: device change feed, outbox ingest, bill series ----------
//
// The edge terminal (apps/edge) bills against a local SQLite copy of the outlet's
// catalog. It stays current by pulling a per-outlet *change feed* (cursor = a
// monotonic per-outlet sequence) and pushes its outbox of finished orders and
// kitchen-status updates back through a device-authenticated ingest endpoint.

/** Catalog entities carried by the change feed. */
export const EDGE_FEED_ENTITIES = [
  "settings",
  "category",
  "item",
  "combo",
  "area",
  "table",
  "staff",
  "coupon",
] as const;
export type EdgeFeedEntity = (typeof EDGE_FEED_ENTITIES)[number];

export interface EdgeFeedChange {
  entity: EdgeFeedEntity;
  id: string;
  op: "upsert" | "delete";
  seq: number;
  data: unknown | null; // null for deletes
}

export interface EdgeFeedDto {
  /** Pass back as `?cursor=` on the next pull. Opaque to the device. */
  cursor: string;
  changes: EdgeFeedChange[];
  hasMore: boolean;
  /** True when the device's cursor was ahead of the server (DB restore): drop the local catalog and apply from scratch. */
  reset: boolean;
  serverTime: string;
}

// Feed payload shapes (what `data` holds per entity).
export interface EdgeSettingsData {
  outletId: string;
  name: string;
  address: string | null;
  gstin: string | null;
  placeOfSupply: string | null;
  upiVpa: string | null;
  themeId: string;
  loyaltyEarnRate: number;
  loyaltyPointValue: number;
}
export interface EdgeCategoryData {
  id: string;
  name: string;
  sortOrder: number;
  stationId: string | null;
  stationName: string | null;
}
export interface EdgeItemData {
  id: string;
  categoryId: string;
  name: string;
  shortCode: string | null;
  price: number;
  isVeg: boolean;
  inStock: boolean;
  taxRate: number;
  sortOrder: number;
  variations: { id: string; name: string; price: number }[];
  addonGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    addons: { id: string; name: string; price: number }[];
  }[];
}
export interface EdgeComboData {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  isVeg: boolean;
  inStock: boolean;
  taxRate: number;
  slots: {
    id: string;
    name: string;
    options: { id: string; itemId: string; name: string; priceDelta: number; isDefault: boolean; isVeg: boolean; inStock: boolean }[];
  }[];
}
export interface EdgeAreaData {
  id: string;
  name: string;
}
export interface EdgeTableData {
  id: string;
  areaId: string;
  name: string;
  seats: number;
  /** A running order the cloud knows about (another terminal / QR). Null when free in the cloud. */
  cloudOccupiedBy: { orderId: string; deviceId: string | null } | null;
}
export interface EdgeStaffData {
  id: string;
  name: string;
  roleName: string;
  permissions: string[];
  isActive: boolean;
  /** scrypt hash of the staff PIN (see apps/api/src/edge/pin.ts), null = no offline login. */
  pinHash: string | null;
}
export interface EdgeCouponData {
  id: string;
  code: string;
  type: "PERCENT" | "FLAT";
  value: number;
  minOrder: number;
  maxDiscount: number | null;
  validFrom: string | null;
  validTo: string | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

// ---------- Device activation ----------

export const EdgeActivateSchema = z.object({
  /** Provisioned terminal id or its deviceToken (EDGE_DEVICE_ID). Omit to register a new POS terminal. */
  terminalRef: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(60).optional(),
});
export type EdgeActivateInput = z.infer<typeof EdgeActivateSchema>;

export interface EdgeActivationDto {
  edgeDeviceId: string;
  terminalId: string;
  outletId: string;
  /** Bearer secret for /edge/device/* — shown once, stored only hashed server-side. */
  deviceToken: string;
  /** The device's own GST invoice series prefix, e.g. "E03". */
  seriesCode: string;
  serverTime: string;
}

export const EdgeStaffPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits"),
});
export type EdgeStaffPinInput = z.infer<typeof EdgeStaffPinSchema>;

// ---------- Outbox ingest ----------

const Money = z.number().min(0).multipleOf(0.01);

export const EdgeOrderLineSchema = z.object({
  itemId: z.string().min(1),
  variationId: z.string().optional(),
  addonIds: z.array(z.string()).default([]),
  quantity: z.number().int().positive(),
  note: z.string().max(200).optional(),
  /** Unit price the device billed INCLUDING addons — the invoice already issued. */
  unitPrice: Money,
  taxRate: z.number().min(0).max(28),
  prepStatus: z.enum(["PENDING", "PREPARING", "READY"]).default("PENDING"),
  preppedAt: z.string().nullable().optional(),
});
export type EdgeOrderLineInput = z.infer<typeof EdgeOrderLineSchema>;

export const EdgeComboLineSchema = z.object({
  comboId: z.string().min(1),
  quantity: z.number().int().positive(),
  note: z.string().max(200).optional(),
  selections: z.array(z.object({ slotId: z.string().min(1), itemId: z.string().min(1) })).default([]),
  unitPrice: Money,
  taxRate: z.number().min(0).max(28),
  prepStatus: z.enum(["PENDING", "PREPARING", "READY"]).default("PENDING"),
  preppedAt: z.string().nullable().optional(),
});
export type EdgeComboLineInput = z.infer<typeof EdgeComboLineSchema>;

export const EdgeBillNoSchema = z.object({
  series: z.string().regex(/^E[0-9A-Z]{2,3}$/),
  fy: z.string().regex(/^\d{4}$/),
  seq: z.number().int().positive(),
  number: z.string().max(16),
});
export type EdgeBillNo = z.infer<typeof EdgeBillNoSchema>;

export const EdgeOrderSchema = z
  .object({
    clientId: z.string().min(1).max(64),
    orderType: OrderType,
    tableId: z.string().nullable().optional(),
    customerName: z.string().max(80).nullable().optional(),
    customerPhone: z.string().max(20).nullable().optional(),
    deliveryAddress: z.string().max(300).nullable().optional(),
    items: z.array(EdgeOrderLineSchema).default([]),
    combos: z.array(EdgeComboLineSchema).default([]),
    status: z.enum(["SETTLED", "CANCELLED"]),
    payments: z
      .array(z.object({ mode: PaymentMode, amount: z.number().positive().multipleOf(0.01), reference: z.string().max(60).optional() }))
      .default([]),
    manualDiscount: Money.default(0),
    couponCode: z.string().max(40).nullable().optional(),
    couponDiscount: Money.default(0),
    /** Totals as printed on the device's invoice. */
    subtotal: Money,
    taxAmount: Money,
    total: Money,
    /** Device invoice number; null only for orders billed before the device had a series (legacy). */
    billNo: EdgeBillNoSchema.nullable().optional(),
    /** Device-clock timestamps (ISO). The server corrects them with the measured skew. */
    createdAt: z.string(),
    closedAt: z.string(),
    createdByStaffId: z.string().nullable().optional(),
    closedByStaffId: z.string().nullable().optional(),
    cancelReason: z.string().max(200).nullable().optional(),
  })
  .refine((o) => o.items.length + o.combos.length > 0, { message: "An order needs at least one line" });
export type EdgeOrderInput = z.infer<typeof EdgeOrderSchema>;

export const EdgeOutboxOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ORDER"), key: z.string().min(1).max(100), order: EdgeOrderSchema }),
  z.object({
    kind: z.literal("KOT_STATUS"),
    key: z.string().min(1).max(100),
    clientId: z.string().min(1).max(64),
    lines: z
      .array(z.object({ lineIndex: z.number().int().min(0), kind: z.enum(["item", "combo"]), prepStatus: z.enum(["PENDING", "PREPARING", "READY"]), preppedAt: z.string().nullable().optional() }))
      .min(1),
  }),
]);
export type EdgeOutboxOp = z.infer<typeof EdgeOutboxOpSchema>;

export const EdgePushSchema = z.object({
  /** Device clock at send time (ISO) — the server derives clock skew from it. */
  deviceTime: z.string(),
  ops: z.array(EdgeOutboxOpSchema).max(100),
});
export type EdgePushInput = z.infer<typeof EdgePushSchema>;

export type EdgeOpStatus = "applied" | "duplicate" | "conflict" | "rejected" | "retry";
export type EdgeConflictKind =
  | "COUPON_LIMIT_EXCEEDED"
  | "COUPON_INVALID"
  | "COUPON_DISCOUNT_MISMATCH"
  | "PRICE_DRIFT"
  | "BILL_NUMBER_DUPLICATE"
  | "BILL_SERIES_MISMATCH"
  | "STAFF_UNKNOWN"
  | "TABLE_UNKNOWN"
  | "CLOCK_SKEW"
  | "REJECTED";

export interface EdgeOpResultDto {
  key: string;
  status: EdgeOpStatus;
  serverId?: string | null;
  billNumber?: string | null;
  /** Non-blocking issues recorded server-side for manager review (the sale itself was kept). */
  conflicts?: { kind: EdgeConflictKind; message: string }[];
  message?: string;
}

export interface EdgePushResultDto {
  results: EdgeOpResultDto[];
  serverTime: string;
  /** serverTime − deviceTime as measured for this request (ms). */
  clockSkewMs: number;
}

// ---------- Console views ----------

export interface EdgeDeviceDto {
  id: string;
  terminalId: string;
  terminalName: string;
  seriesCode: string;
  activatedAt: string;
  lastPushAt: string | null;
  lastPullAt: string | null;
  clockSkewMs: number | null;
  revokedAt: string | null;
  openConflicts: number;
}

export interface EdgeStaffPinRowDto {
  userId: string;
  name: string;
  roleName: string;
  hasPin: boolean;
  pinUpdatedAt: string | null;
}

export interface EdgeConflictDto {
  id: string;
  edgeDeviceId: string;
  seriesCode: string | null;
  clientId: string;
  orderId: string | null;
  billNumber: string | null;
  kind: EdgeConflictKind;
  message: string;
  detail: unknown;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export const EdgeResolveConflictSchema = z.object({ note: z.string().min(1).max(300) });
export type EdgeResolveConflictInput = z.infer<typeof EdgeResolveConflictSchema>;

export interface EdgeSeriesRowDto {
  edgeDeviceId: string;
  seriesCode: string;
  fiscalYear: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
  /** Sequence numbers missing between first and last (capped at 50). */
  missing: number[];
}

// ---------- Offline bill numbering (pure, shared by device + server) ----------

/** IST is UTC+05:30 with no DST — Indian fiscal years roll over on 1 April IST. */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** Fiscal-year code for an instant, e.g. 2026-10-26 → "2627" (FY 2026-27). */
export function fiscalYearCode(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * GST invoice number for an offline bill: `<series>/<fy>/<seq>` e.g. `E03/2627/000042`.
 * Rule 46(b) CGST: ≤16 chars, unique per financial year, characters limited to
 * letters, digits, "-" and "/". Each device has its own series, so devices never
 * contend for a number while offline and every series stays consecutive.
 */
export function formatEdgeBillNumber(series: string, fy: string, seq: number): string {
  const n = `${series}/${fy}/${String(seq).padStart(6, "0")}`;
  if (n.length > 16) throw new Error(`Bill number ${n} exceeds 16 characters`);
  return n;
}

export function parseEdgeBillNumber(n: string): { series: string; fy: string; seq: number } | null {
  const m = /^(E[0-9A-Z]{2,3})\/(\d{4})\/(\d{6,})$/.exec(n);
  return m ? { series: m[1], fy: m[2], seq: Number(m[3]) } : null;
}

/** Series codes are allocated per outlet: E01..E99, then E100.. */
export function edgeSeriesCode(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 999) throw new Error("Series index out of range");
  return `E${String(index).padStart(2, "0")}`;
}
