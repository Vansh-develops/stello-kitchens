import { BadRequestException } from "@nestjs/common";
import type { OrderType } from "@stello/shared";
import { DEFAULT_OUTLET_TIMEZONE, isWithinWindow, minutesInZone } from "@stello/shared";
import { Prisma } from "@prisma/client";

/**
 * Billing rules shared by the order paths (POS, scan, aggregator, sync). Plain
 * functions over a transaction client — no DI — so OrdersService can use them
 * without a module cycle.
 */

export interface BillingRules {
  serviceChargeEnabled: boolean;
  serviceChargePercent: number;
  serviceChargeTaxable: boolean;
  serviceChargeOrderTypes: string[];
  roundOffEnabled: boolean;
  timezone: string;
}

export const DEFAULT_BILLING_RULES: BillingRules = {
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  serviceChargeTaxable: true,
  serviceChargeOrderTypes: ["DINE_IN"],
  roundOffEnabled: false,
  timezone: DEFAULT_OUTLET_TIMEZONE,
};

type Db = Prisma.TransactionClient;

export async function loadBillingRules(db: Db, tenantId: string, outletId: string): Promise<BillingRules> {
  const row = await db.outletBillingSettings.findFirst({ where: { tenantId, outletId } });
  if (!row) return { ...DEFAULT_BILLING_RULES };
  return {
    serviceChargeEnabled: row.serviceChargeEnabled,
    serviceChargePercent: Number(row.serviceChargePercent),
    serviceChargeTaxable: row.serviceChargeTaxable,
    serviceChargeOrderTypes: row.serviceChargeOrderTypes,
    roundOffEnabled: row.roundOffEnabled,
    timezone: row.timezone,
  };
}

/** The service charge an order attracts under the outlet rules, or null. */
export function serviceChargeFor(
  rules: BillingRules,
  order: { orderType: string; serviceChargeWaived: boolean },
): { percent: number; taxable: boolean } | null {
  if (!rules.serviceChargeEnabled || rules.serviceChargePercent <= 0 || order.serviceChargeWaived) return null;
  if (!rules.serviceChargeOrderTypes.includes(order.orderType)) return null;
  return { percent: rules.serviceChargePercent, taxable: rules.serviceChargeTaxable };
}

// ---------- Channel pricing ----------

/**
 * Where a punch comes from. Channel prices are looked up by the outlet's
 * channel names (normalised), most specific first, falling back per item to
 * the next candidate and finally to item.price.
 */
export type PriceSource =
  | { kind: "POS"; orderType: OrderType | string }
  | { kind: "SCAN"; mode: "DINE_IN" | "TAKEAWAY" }
  | { kind: "AGGREGATOR"; channelName?: string | null }
  | { kind: "SYNC"; orderType: OrderType | string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ORDER_TYPE_NAMES: Record<string, string[]> = {
  DINE_IN: ["dinein", "dining", "restaurant"],
  TAKEAWAY: ["takeaway", "takeout", "parcel", "pickup"],
  DELIVERY: ["delivery", "homedelivery"],
};
const SCAN_NAMES = ["scanorder", "scanandorder", "qrorder", "qr", "online"];

export function channelCandidates(source: PriceSource): string[] {
  switch (source.kind) {
    case "POS":
    case "SYNC":
      return ORDER_TYPE_NAMES[source.orderType] ?? [];
    case "SCAN":
      return [...SCAN_NAMES, ...(ORDER_TYPE_NAMES[source.mode] ?? [])];
    case "AGGREGATOR":
      return [...(source.channelName ? [norm(source.channelName)] : []), ...ORDER_TYPE_NAMES.DELIVERY];
  }
}

/** itemId → channel price for this punch source (items without one are absent). */
export async function resolveChannelPrices(
  db: Db,
  tenantId: string,
  outletId: string,
  itemIds: string[],
  source: PriceSource,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (itemIds.length === 0) return result;
  const candidates = channelCandidates(source);
  if (candidates.length === 0) return result;
  const channels = await db.channel.findMany({ where: { tenantId, outletId, isActive: true } });
  // Rank this outlet's channels by the first candidate name they match.
  const ranked = channels
    .map((c) => ({ id: c.id, rank: candidates.indexOf(norm(c.name)) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return result;
  const prices = await db.itemChannelPrice.findMany({
    where: { itemId: { in: itemIds }, channelId: { in: ranked.map((c) => c.id) } },
  });
  for (const itemId of itemIds) {
    for (const ch of ranked) {
      const p = prices.find((x) => x.itemId === itemId && x.channelId === ch.id);
      if (p) {
        result.set(itemId, Number(p.price));
        break;
      }
    }
  }
  return result;
}

// ---------- Availability windows ----------

export function isAvailableNow(
  item: { availableStart: string | null; availableEnd: string | null },
  timezone: string,
  at: Date = new Date(),
): boolean {
  return isWithinWindow(item.availableStart, item.availableEnd, minutesInZone(at, timezone));
}

export function windowLabel(item: { availableStart: string | null; availableEnd: string | null }): string {
  return `${item.availableStart ?? "00:00"}–${item.availableEnd ?? "24:00"}`;
}

/** Reject a punch containing an item outside its sale window (outlet-local time). */
export function assertAvailable(
  item: { name: string; availableStart: string | null; availableEnd: string | null },
  timezone: string,
  at: Date = new Date(),
) {
  if (!isAvailableNow(item, timezone, at)) {
    throw new BadRequestException(`${item.name} is not available right now (served ${windowLabel(item)})`);
  }
}
