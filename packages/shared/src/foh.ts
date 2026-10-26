import { z } from "zod";

// ---------- Front of house: floor plan, reservations, waitlist, server calls, CFD ----------

export const TableShape = z.enum(["ROUND", "SQUARE", "RECT"]);
export type TableShape = z.infer<typeof TableShape>;

export const FLOOR_LIMITS = {
  minCanvas: 200,
  maxCanvas: 4000,
  minTable: 30,
  maxTable: 600,
  maxSeats: 40,
} as const;

export const TablePlacementInputSchema = z.object({
  /** Existing table id; omit to create a new table in this area. */
  tableId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(20),
  seats: z.number().int().min(1).max(FLOOR_LIMITS.maxSeats),
  shape: TableShape,
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(FLOOR_LIMITS.minTable).max(FLOOR_LIMITS.maxTable),
  height: z.number().int().min(FLOOR_LIMITS.minTable).max(FLOOR_LIMITS.maxTable),
  rotation: z.number().int().min(0).max(359).default(0),
});
export type TablePlacementInput = z.infer<typeof TablePlacementInputSchema>;

export const SaveFloorPlanSchema = z
  .object({
    width: z.number().int().min(FLOOR_LIMITS.minCanvas).max(FLOOR_LIMITS.maxCanvas),
    height: z.number().int().min(FLOOR_LIMITS.minCanvas).max(FLOOR_LIMITS.maxCanvas),
    tables: z.array(TablePlacementInputSchema).max(200),
  })
  .superRefine((plan, ctx) => {
    for (const issue of floorLayoutIssues(plan)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  });
export type SaveFloorPlanInput = z.infer<typeof SaveFloorPlanSchema>;

type LayoutLike = {
  width: number;
  height: number;
  tables: { tableId?: string; name: string; shape: TableShape; x: number; y: number; width: number; height: number }[];
};

/**
 * Geometric validation of a floor plan: every table inside the canvas, round
 * tables are circles (width = height), names and ids unique, and no two tables
 * overlap (axis-aligned footprint; rotation is cosmetic for overlap purposes).
 */
export function floorLayoutIssues(plan: LayoutLike): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const names = new Map<string, number>();
  const ids = new Map<string, number>();
  plan.tables.forEach((t, i) => {
    if (t.x < 0 || t.y < 0 || t.x + t.width > plan.width || t.y + t.height > plan.height) {
      issues.push({ path: ["tables", i], message: `${t.name} is outside the floor area` });
    }
    if (t.shape === "ROUND" && t.width !== t.height) {
      issues.push({ path: ["tables", i, "height"], message: `${t.name}: round tables need equal width and height` });
    }
    const key = t.name.trim().toLowerCase();
    if (names.has(key)) issues.push({ path: ["tables", i, "name"], message: `Duplicate table name ${t.name}` });
    names.set(key, i);
    if (t.tableId) {
      if (ids.has(t.tableId)) issues.push({ path: ["tables", i, "tableId"], message: `${t.name} is placed twice` });
      ids.set(t.tableId, i);
    }
  });
  for (let i = 0; i < plan.tables.length; i++) {
    for (let j = i + 1; j < plan.tables.length; j++) {
      const a = plan.tables[i];
      const b = plan.tables[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlap) issues.push({ path: ["tables", j], message: `${b.name} overlaps ${a.name}` });
    }
  }
  return issues;
}

export const FloorTableStatus = z.enum(["FREE", "OCCUPIED", "BILL_PRINTED", "RESERVED"]);
export type FloorTableStatus = z.infer<typeof FloorTableStatus>;

export interface FloorTableDto {
  id: string;
  name: string;
  seats: number;
  areaId: string;
  placement: { x: number; y: number; width: number; height: number; rotation: number; shape: TableShape } | null;
  status: FloorTableStatus;
  orderId: string | null;
  orderTotal: number | null;
  /** When the running order (or seated reservation) began — drives the running timer. */
  since: string | null;
  reservation: { id: string; guestName: string; partySize: number; startAt: string; status: ReservationStatus } | null;
  waiterNames: string[];
  openCalls: ServerCallType[];
}

export interface FloorAreaDto {
  id: string;
  name: string;
  width: number;
  height: number;
  tables: FloorTableDto[];
}

export interface FloorViewDto {
  areas: FloorAreaDto[];
  serverTime: string;
}

// ---------- Reservations ----------

export const ReservationStatus = z.enum(["BOOKED", "CONFIRMED", "SEATED", "NO_SHOW", "CANCELLED"]);
export type ReservationStatus = z.infer<typeof ReservationStatus>;
export const ReservationSource = z.enum(["PHONE", "WALK_IN", "WEB", "AGGREGATOR", "OTHER"]);
export type ReservationSource = z.infer<typeof ReservationSource>;

/** Statuses that hold a table for their time window. */
export const BLOCKING_RESERVATION_STATUSES: ReservationStatus[] = ["BOOKED", "CONFIRMED", "SEATED"];

/** Allowed status moves (seating has its own endpoint, but is listed for completeness). */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  BOOKED: ["CONFIRMED", "SEATED", "NO_SHOW", "CANCELLED"],
  CONFIRMED: ["BOOKED", "SEATED", "NO_SHOW", "CANCELLED"],
  SEATED: [],
  NO_SHOW: ["BOOKED"],
  CANCELLED: ["BOOKED"],
};

const phone = z.string().trim().regex(/^\+?[0-9]{6,15}$/, "Enter a valid phone number");

export const ReservationInputSchema = z.object({
  guestName: z.string().trim().min(1).max(80),
  phone,
  partySize: z.number().int().min(1).max(100),
  startAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(480).default(90),
  tableIds: z.array(z.string().min(1)).max(10).default([]),
  notes: z.string().trim().max(500).optional(),
  source: ReservationSource.default("PHONE"),
});
export type ReservationInput = z.infer<typeof ReservationInputSchema>;

export const UpdateReservationSchema = ReservationInputSchema.partial();
export type UpdateReservationInput = z.infer<typeof UpdateReservationSchema>;

export const ReservationStatusSchema = z.object({ status: ReservationStatus });

/** Half-open interval overlap: a booking ending at 20:00 does not clash with one at 20:00. */
export function intervalsOverlap(aStart: number, aMinutes: number, bStart: number, bMinutes: number): boolean {
  return aStart < bStart + bMinutes * 60_000 && bStart < aStart + aMinutes * 60_000;
}

export interface ReservationDto {
  id: string;
  guestName: string;
  phone: string;
  partySize: number;
  startAt: string;
  durationMinutes: number;
  status: ReservationStatus;
  source: ReservationSource;
  notes: string | null;
  tables: { id: string; name: string }[];
  customer: { id: string; name: string | null; totalOrders: number; lastVisitAt: string | null } | null;
  seatedAt: string | null;
  createdAt: string;
}

// ---------- Waitlist ----------

export const WaitlistStatus = z.enum(["WAITING", "NOTIFIED", "SEATED", "LEFT"]);
export type WaitlistStatus = z.infer<typeof WaitlistStatus>;

export const WaitlistInputSchema = z.object({
  guestName: z.string().trim().min(1).max(80),
  phone: phone.optional(),
  partySize: z.number().int().min(1).max(100),
  quotedMinutes: z.number().int().min(0).max(240).default(15),
  notes: z.string().trim().max(300).optional(),
});
export type WaitlistInput = z.infer<typeof WaitlistInputSchema>;

export const SeatSchema = z.object({ tableId: z.string().min(1) });
export type SeatInput = z.infer<typeof SeatSchema>;

export interface WaitlistEntryDto {
  id: string;
  guestName: string;
  phone: string | null;
  partySize: number;
  quotedMinutes: number;
  status: WaitlistStatus;
  notes: string | null;
  tableId: string | null;
  notifiedAt: string | null;
  seatedAt: string | null;
  createdAt: string;
}

// ---------- Server calls ----------

export const ServerCallType = z.enum(["WAITER", "WATER", "BILL"]);
export type ServerCallType = z.infer<typeof ServerCallType>;
export const ServerCallStatus = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
export type ServerCallStatus = z.infer<typeof ServerCallStatus>;

export const CallServerSchema = z.object({ type: ServerCallType.default("WAITER") });
export type CallServerInput = z.infer<typeof CallServerSchema>;

export interface ServerCallDto {
  id: string;
  tableId: string;
  tableName: string;
  areaId: string | null;
  type: ServerCallType;
  source: "DINER" | "STAFF";
  status: ServerCallStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  /** Staff ids whose section covers this table (empty = unassigned). */
  assignedUserIds: string[];
}

// ---------- Waiter assignment ----------

export const WaiterAssignmentSchema = z.object({
  userId: z.string().min(1),
  areaIds: z.array(z.string().min(1)).default([]),
  tableIds: z.array(z.string().min(1)).default([]),
});
export type WaiterAssignmentInput = z.infer<typeof WaiterAssignmentSchema>;

export interface WaiterSectionDto {
  userId: string;
  name: string;
  roleName: string;
  areaIds: string[];
  tableIds: string[];
}

// ---------- Customer-facing display ----------

export interface CfdLine {
  name: string;
  detail?: string | null;
  quantity: number;
  amount: number;
  pending?: boolean;
}

export const CfdStateSchema = z.object({
  mode: z.enum(["IDLE", "CART", "PAYMENT", "THANKS"]),
  label: z.string().max(60).nullable().default(null),
  lines: z
    .array(
      z.object({
        name: z.string().max(120),
        detail: z.string().max(200).nullable().optional(),
        quantity: z.number().int().min(0).max(9999),
        amount: z.number().finite(),
        pending: z.boolean().optional(),
      }),
    )
    .max(200)
    .default([]),
  subtotal: z.number().finite().default(0),
  discount: z.number().finite().default(0),
  tax: z.number().finite().default(0),
  total: z.number().finite().default(0),
  upi: z
    .object({ upiString: z.string().startsWith("upi://").max(1000), amount: z.number().finite(), payeeVpa: z.string().max(100) })
    .nullable()
    .default(null),
});
export type CfdState = z.infer<typeof CfdStateSchema>;

export const CfdPairSchema = z.object({ code: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code") });

export interface CfdSessionDto {
  id: string;
  paired: boolean;
  pairingCode: string | null;
  brandName: string | null;
  outletName: string | null;
  themeId: string | null;
  state: CfdState | null;
}

// ---------- Media ----------

export const MEDIA_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxDimension: 4096,
  types: ["image/jpeg", "image/png", "image/webp"] as const,
} as const;
