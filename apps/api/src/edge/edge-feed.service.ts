import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  EdgeAreaData,
  EdgeCategoryData,
  EdgeComboData,
  EdgeCouponData,
  EdgeFeedChange,
  EdgeFeedDto,
  EdgeFeedEntity,
  EdgeItemData,
  EdgeSettingsData,
  EdgeStaffData,
  EdgeTableData,
} from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { EdgeDeviceContext } from "./edge-device.guard";

type Row = { entity: EdgeFeedEntity; id: string; data: unknown };

// Refreshing recomputes the outlet's catalog; with several terminals polling, skip
// a recompute if one ran this recently (the reads still serve committed rows).
export const FEED_REFRESH_MIN_INTERVAL_MS = 3000;
const MAX_PAGE = 1000;

// Canonical JSON so equal content always hashes the same regardless of key order.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const hashOf = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");

/**
 * Per-outlet change feed for offline edge devices.
 *
 * Most catalog tables have no `updatedAt`, and changes arrive through many code
 * paths (menu edits, 86-ing from the KDS, coupon redemptions, staff changes), so
 * instead of trusting timestamps the feed is *materialised*: a refresh recomputes
 * every entity, compares its content hash with the stored `EdgeFeedEntry`, and
 * stamps changed/removed rows with the next per-outlet sequence number. Devices
 * pull `seq > cursor`. Refreshes for an outlet are serialised by a row lock on
 * `EdgeFeedState`, so sequence numbers commit in order and a cursor never skips
 * a row.
 */
@Injectable()
export class EdgeFeedService {
  constructor(private readonly prisma: PrismaService) {}

  async feed(
    device: EdgeDeviceContext,
    cursorRaw: string | undefined,
    limitRaw?: string,
    minIntervalMs = FEED_REFRESH_MIN_INTERVAL_MS,
  ): Promise<EdgeFeedDto> {
    const cursor = cursorRaw === undefined || cursorRaw === "" ? 0 : Number(cursorRaw);
    if (!Number.isInteger(cursor) || cursor < 0) throw new BadRequestException("Invalid feed cursor");
    const limit = Math.min(Math.max(Number(limitRaw) || 500, 1), MAX_PAGE);

    const lastSeq = await this.refresh(device.tenantId, device.outletId, minIntervalMs);
    // A cursor ahead of the server means the server's feed was rebuilt (restore):
    // tell the device to drop its catalog and start from zero.
    const reset = cursor > lastSeq;
    const from = reset ? 0 : cursor;
    const rows = await this.prisma.edgeFeedEntry.findMany({
      where: { tenantId: device.tenantId, outletId: device.outletId, seq: { gt: from } },
      orderBy: { seq: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    await this.prisma.edgeDevice.update({ where: { id: device.edgeDeviceId }, data: { lastPullAt: new Date() } });
    return {
      cursor: String(page.length ? page[page.length - 1].seq : from),
      changes: page.map(
        (r): EdgeFeedChange => ({
          entity: r.entity as EdgeFeedEntity,
          id: r.entityId,
          op: r.deleted ? "delete" : "upsert",
          seq: r.seq,
          data: r.deleted ? null : r.data,
        }),
      ),
      hasMore: rows.length > limit,
      reset,
      serverTime: new Date().toISOString(),
    };
  }

  /** Recompute the outlet's catalog and record changes. Returns the outlet's latest seq. */
  async refresh(tenantId: string, outletId: string, minIntervalMs = FEED_REFRESH_MIN_INTERVAL_MS): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        // ON CONFLICT DO NOTHING: concurrent first refreshes must not race on the insert.
        await tx.$executeRaw`
          INSERT INTO edge_feed_states ("outletId", "tenantId", "lastSeq", "refreshedAt")
          VALUES (${outletId}, ${tenantId}, 0, to_timestamp(0))
          ON CONFLICT ("outletId") DO NOTHING`;
        const [state] = await tx.$queryRaw<{ lastSeq: number; refreshedAt: Date }[]>`
          SELECT "lastSeq", "refreshedAt" FROM edge_feed_states WHERE "outletId" = ${outletId} FOR UPDATE`;
        if (Date.now() - state.refreshedAt.getTime() < minIntervalMs) return state.lastSeq;

        const current = await this.buildRows(tx, tenantId, outletId);
        const stored = await tx.edgeFeedEntry.findMany({
          where: { tenantId, outletId },
          select: { id: true, entity: true, entityId: true, hash: true, deleted: true },
        });
        const storedByKey = new Map(stored.map((s) => [`${s.entity}:${s.entityId}`, s]));
        let seq = state.lastSeq;
        const creates: Prisma.EdgeFeedEntryCreateManyInput[] = [];
        const seen = new Set<string>();

        for (const row of current) {
          const key = `${row.entity}:${row.id}`;
          seen.add(key);
          const hash = hashOf(row.data);
          const prev = storedByKey.get(key);
          if (!prev) {
            creates.push({ tenantId, outletId, entity: row.entity, entityId: row.id, hash, seq: ++seq, data: row.data as Prisma.InputJsonValue });
          } else if (prev.hash !== hash || prev.deleted) {
            await tx.edgeFeedEntry.update({
              where: { id: prev.id },
              data: { hash, seq: ++seq, deleted: false, data: row.data as Prisma.InputJsonValue },
            });
          }
        }
        for (const prev of stored) {
          if (!prev.deleted && !seen.has(`${prev.entity}:${prev.entityId}`)) {
            await tx.edgeFeedEntry.update({
              where: { id: prev.id },
              data: { hash: "deleted", seq: ++seq, deleted: true, data: Prisma.DbNull },
            });
          }
        }
        if (creates.length) await tx.edgeFeedEntry.createMany({ data: creates });
        await tx.edgeFeedState.update({ where: { outletId }, data: { lastSeq: seq, refreshedAt: new Date() } });
        return seq;
      },
      { timeout: 30000, maxWait: 15000 },
    );
  }

  /** The outlet's full offline catalog as feed rows. */
  private async buildRows(tx: Prisma.TransactionClient, tenantId: string, outletId: string): Promise<Row[]> {
    const outlet = await tx.outlet.findFirstOrThrow({
      where: { id: outletId, tenantId },
      include: { brand: { select: { themeId: true } } },
    });
    const categories = await tx.menuCategory.findMany({ where: { tenantId, outletId, deletedAt: null }, include: { station: true } });
    const items = await tx.item.findMany({
      where: { tenantId, outletId, deletedAt: null, category: { deletedAt: null } },
      include: { variations: true, addonGroups: { include: { group: { include: { addons: true } } } } },
    });
    const combos = await tx.combo.findMany({
      where: { tenantId, outletId, deletedAt: null, category: { deletedAt: null } },
      include: { slots: { orderBy: { sortOrder: "asc" }, include: { options: { include: { item: true } } } } },
    });
    const areas = await tx.area.findMany({ where: { tenantId, outletId } });
    const tables = await tx.diningTable.findMany({ where: { tenantId, outletId } });
    const staff = await tx.user.findMany({ where: { tenantId, userOutlets: { some: { outletId } } }, include: { role: true } });
    const coupons = await tx.coupon.findMany({ where: { tenantId, outletId } });
    const openOrders = await tx.order.findMany({
      where: { tenantId, outletId, status: "OPEN", tableId: { not: null } },
      select: { id: true, tableId: true, deviceId: true },
    });
    const pins = await tx.edgeStaffPin.findMany({ where: { tenantId, userId: { in: staff.map((s) => s.id) } } });
    const pinByUser = new Map(pins.map((p) => [p.userId, p.pinHash]));
    const occupied = new Map(openOrders.map((o) => [o.tableId!, { orderId: o.id, deviceId: o.deviceId }]));
    const sortById = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

    const rows: Row[] = [];
    const settings: EdgeSettingsData = {
      outletId: outlet.id,
      name: outlet.name,
      address: outlet.address,
      gstin: outlet.gstin,
      placeOfSupply: outlet.placeOfSupply,
      upiVpa: outlet.upiVpa,
      themeId: outlet.brand.themeId,
      loyaltyEarnRate: Number(outlet.loyaltyEarnRate),
      loyaltyPointValue: Number(outlet.loyaltyPointValue),
    };
    rows.push({ entity: "settings", id: "outlet", data: settings });

    for (const c of categories) {
      const data: EdgeCategoryData = { id: c.id, name: c.name, sortOrder: c.sortOrder, stationId: c.stationId, stationName: c.station?.name ?? null };
      rows.push({ entity: "category", id: c.id, data });
    }
    for (const i of items) {
      const data: EdgeItemData = {
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        shortCode: i.shortCode,
        price: Number(i.price),
        isVeg: i.isVeg,
        inStock: i.inStock,
        taxRate: Number(i.taxRate),
        sortOrder: i.sortOrder,
        variations: [...i.variations].sort(sortById).map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })),
        addonGroups: [...i.addonGroups]
          .sort((a, b) => a.addonGroupId.localeCompare(b.addonGroupId))
          .map(({ group }) => ({
            id: group.id,
            name: group.name,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            addons: [...group.addons].sort(sortById).map((a) => ({ id: a.id, name: a.name, price: Number(a.price) })),
          })),
      };
      rows.push({ entity: "item", id: i.id, data });
    }
    for (const c of combos) {
      const data: EdgeComboData = {
        id: c.id,
        categoryId: c.categoryId,
        name: c.name,
        price: Number(c.price),
        isVeg: c.isVeg,
        inStock: c.inStock,
        taxRate: Number(c.taxRate),
        slots: c.slots.map((s) => ({
          id: s.id,
          name: s.name,
          options: [...s.options].sort(sortById).map((o) => ({
            id: o.id,
            itemId: o.itemId,
            name: o.item.name,
            priceDelta: Number(o.priceDelta),
            isDefault: o.isDefault,
            isVeg: o.item.isVeg,
            inStock: o.item.inStock && !o.item.deletedAt,
          })),
        })),
      };
      rows.push({ entity: "combo", id: c.id, data });
    }
    for (const a of areas) {
      const data: EdgeAreaData = { id: a.id, name: a.name };
      rows.push({ entity: "area", id: a.id, data });
    }
    for (const t of tables) {
      const data: EdgeTableData = { id: t.id, areaId: t.areaId, name: t.name, seats: t.seats, cloudOccupiedBy: occupied.get(t.id) ?? null };
      rows.push({ entity: "table", id: t.id, data });
    }
    for (const u of staff) {
      const data: EdgeStaffData = {
        id: u.id,
        name: u.name,
        roleName: u.role.name,
        permissions: Array.isArray(u.role.permissions) ? (u.role.permissions as string[]) : [],
        isActive: u.isActive,
        pinHash: u.isActive ? (pinByUser.get(u.id) ?? null) : null,
      };
      rows.push({ entity: "staff", id: u.id, data });
    }
    for (const c of coupons) {
      const data: EdgeCouponData = {
        id: c.id,
        code: c.code,
        type: c.type as "PERCENT" | "FLAT",
        value: Number(c.value),
        minOrder: Number(c.minOrder),
        maxDiscount: c.maxDiscount != null ? Number(c.maxDiscount) : null,
        validFrom: c.validFrom?.toISOString() ?? null,
        validTo: c.validTo?.toISOString() ?? null,
        usageLimit: c.usageLimit,
        usedCount: c.usedCount,
        isActive: c.isActive,
      };
      rows.push({ entity: "coupon", id: c.id, data });
    }
    return rows;
  }
}
