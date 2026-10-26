import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  EdgeConflictKind,
  EdgeOpResultDto,
  EdgeOrderInput,
  EdgeOutboxOp,
  EdgePushInput,
  EdgePushResultDto,
} from "@stello/shared";
import { computeOrderTotals, evaluateCoupon, formatEdgeBillNumber, fromPaise, lineTotalPaise, toPaise } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import type { EdgeDeviceContext } from "./edge-device.guard";

type Tx = Prisma.TransactionClient;
type Conflict = { kind: EdgeConflictKind; message: string; detail?: unknown };

/** The device's own arithmetic disagrees with the server: the op is not applied. */
class RejectOp extends Error {}

// Device timestamps more than this far from the server clock are flagged.
const SKEW_WARN_MS = 5 * 60 * 1000;

/**
 * Applies an edge device's outbox. Offline sales are FACTS: the customer has
 * paid and holds a tax invoice numbered from the device's own series. So unlike
 * the online settle path, ingest never refuses a sale because the world moved on
 * while the device was offline (an item was 86'd, a price changed, a coupon ran
 * out on another terminal, a staff member was deactivated). It records the order
 * exactly as billed and files an `EdgeSyncConflict` for a manager to review.
 *
 * The only refusals are an order whose own figures do not add up (device bug or
 * tampering — the server cannot know which number is real) or that references
 * catalog rows the outlet never had. Those are stored as REJECTED conflicts with
 * the full payload so nothing is silently lost.
 *
 * Idempotency: each order is keyed by (terminal, clientId) — the same unique key
 * the legacy /sync/push path uses — so a retried batch reports `duplicate`.
 */
@Injectable()
export class EdgeIngestService {
  private readonly log = new Logger(EdgeIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async push(device: EdgeDeviceContext, input: EdgePushInput): Promise<EdgePushResultDto> {
    const serverNow = Date.now();
    const deviceNow = Date.parse(input.deviceTime);
    const clockSkewMs = Number.isNaN(deviceNow) ? 0 : serverNow - deviceNow;
    await this.prisma.edgeDevice.update({
      where: { id: device.edgeDeviceId },
      data: { lastPushAt: new Date(serverNow), clockSkewMs: Math.max(Math.min(clockSkewMs, 2_000_000_000), -2_000_000_000) },
    });

    const results: EdgeOpResultDto[] = [];
    let touched = false;
    for (const op of input.ops) {
      const res = op.kind === "ORDER" ? await this.applyOrder(device, op, clockSkewMs) : await this.applyKotStatus(device, op);
      if (res.status === "applied") touched = true;
      results.push(res);
    }
    if (touched) this.realtime.notifyOutlet(device.outletId);
    return { results, serverTime: new Date().toISOString(), clockSkewMs };
  }

  // ---------- orders ----------

  private async applyOrder(
    device: EdgeDeviceContext,
    op: Extract<EdgeOutboxOp, { kind: "ORDER" }>,
    skewMs: number,
  ): Promise<EdgeOpResultDto> {
    const order = op.order;
    const where = { tenantId: device.tenantId, outletId: device.outletId, deviceId: device.terminalId, clientId: order.clientId };
    const existing = await this.prisma.order.findFirst({ where });
    if (existing) return { key: op.key, status: "duplicate", serverId: existing.id, billNumber: existing.billNumber };

    try {
      const { orderId, billNumber, conflicts } = await this.prisma.$transaction((tx) => this.insertOrder(tx, device, order, skewMs), {
        timeout: 20000,
      });
      return {
        key: op.key,
        status: conflicts.length ? "conflict" : "applied",
        serverId: orderId,
        billNumber,
        conflicts: conflicts.map((c) => ({ kind: c.kind, message: c.message })),
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Lost a race with a concurrent delivery of the same order.
        const dup = await this.prisma.order.findFirst({ where });
        if (dup) return { key: op.key, status: "duplicate", serverId: dup.id, billNumber: dup.billNumber };
        return { key: op.key, status: "retry", message: "Invoice number collision; will retry" };
      }
      if (err instanceof RejectOp) {
        await this.prisma.edgeSyncConflict.create({
          data: {
            tenantId: device.tenantId,
            outletId: device.outletId,
            edgeDeviceId: device.edgeDeviceId,
            clientId: order.clientId,
            billNumber: order.billNo?.number ?? null,
            kind: "REJECTED",
            message: err.message,
            detail: { order } as unknown as Prisma.InputJsonValue,
          },
        });
        return { key: op.key, status: "rejected", message: err.message, billNumber: order.billNo?.number ?? null };
      }
      this.log.warn(`edge order ${order.clientId} not applied: ${err instanceof Error ? err.message : err}`);
      return { key: op.key, status: "retry", message: "Temporary server error" };
    }
  }

  private async insertOrder(tx: Tx, device: EdgeDeviceContext, order: EdgeOrderInput, skewMs: number) {
    const { tenantId, outletId } = device;
    const conflicts: Conflict[] = [];
    const settled = order.status === "SETTLED";
    const corrected = (iso: string) => {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return new Date();
      return new Date(Math.min(t + skewMs, Date.now()));
    };
    const createdAt = corrected(order.createdAt);
    const closedAt = corrected(order.closedAt);
    if (Math.abs(skewMs) > SKEW_WARN_MS) {
      conflicts.push({
        kind: "CLOCK_SKEW",
        message: `Device clock was off by ${Math.round(skewMs / 1000)}s; sale times were corrected`,
        detail: { skewMs, deviceCreatedAt: order.createdAt, correctedCreatedAt: createdAt.toISOString() },
      });
    }

    // ---- staff attribution ----
    const staffIds = [...new Set([order.createdByStaffId, order.closedByStaffId].filter((s): s is string => !!s))];
    const staff = staffIds.length
      ? await tx.user.findMany({ where: { tenantId, id: { in: staffIds }, userOutlets: { some: { outletId } } }, select: { id: true } })
      : [];
    const known = new Set(staff.map((s) => s.id));
    const staffOrNull = (id: string | null | undefined) => {
      if (!id) return null;
      if (known.has(id)) return id;
      conflicts.push({ kind: "STAFF_UNKNOWN", message: `Staff ${id} is not a member of this outlet`, detail: { staffId: id } });
      return null;
    };
    const createdById = staffOrNull(order.createdByStaffId);
    const closedById = order.closedByStaffId === order.createdByStaffId ? createdById : staffOrNull(order.closedByStaffId);

    // ---- table (kept even if the table was deleted since; the sale stands) ----
    let tableId: string | null = null;
    if (order.orderType === "DINE_IN" && order.tableId) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM dining_tables WHERE id = ${order.tableId} AND "tenantId" = ${tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (rows.length) tableId = order.tableId;
      else conflicts.push({ kind: "TABLE_UNKNOWN", message: "Dine-in table no longer exists; order filed without a table", detail: { tableId: order.tableId } });
    }

    // ---- figures must add up exactly as printed ----
    const lineMoney = [
      ...order.items.map((l) => ({ lineTotalPaise: lineTotalPaise(l.unitPrice, l.quantity), taxRatePercent: l.taxRate })),
      ...order.combos.map((l) => ({ lineTotalPaise: lineTotalPaise(l.unitPrice, l.quantity), taxRatePercent: l.taxRate })),
    ];
    const discount = fromPaise(toPaise(order.manualDiscount) + toPaise(order.couponDiscount));
    const totals = computeOrderTotals(lineMoney, discount);
    if (toPaise(totals.subtotal) !== toPaise(order.subtotal) || toPaise(totals.taxAmount) !== toPaise(order.taxAmount) || toPaise(totals.total) !== toPaise(order.total)) {
      throw new RejectOp(`Order figures do not add up (device total ${order.total}, recomputed ${totals.total})`);
    }
    if (settled) {
      const paid = order.payments.reduce((s, p) => s + toPaise(p.amount), 0);
      if (paid !== toPaise(totals.total)) throw new RejectOp(`Payments ${fromPaise(paid)} do not equal total ${totals.total}`);
    }

    // ---- coupon: validated against the authoritative count at sync time ----
    let couponCode: string | null = null;
    if (order.couponCode) {
      const code = order.couponCode.toUpperCase();
      couponCode = code;
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM coupons WHERE "outletId" = ${outletId} AND "tenantId" = ${tenantId} AND code = ${code} FOR UPDATE`;
      const coupon = locked.length ? await tx.coupon.findUniqueOrThrow({ where: { id: locked[0].id } }) : null;
      const evaluation = evaluateCoupon(
        coupon
          ? {
              type: coupon.type as "PERCENT" | "FLAT",
              value: Number(coupon.value),
              minOrder: Number(coupon.minOrder),
              maxDiscount: coupon.maxDiscount != null ? Number(coupon.maxDiscount) : null,
              validFrom: coupon.validFrom?.toISOString() ?? null,
              validTo: coupon.validTo?.toISOString() ?? null,
              usageLimit: coupon.usageLimit,
              usedCount: coupon.usedCount,
              isActive: coupon.isActive,
            }
          : null,
        totals.subtotal,
        closedAt.toISOString(), // validity window judged at the (corrected) sale time
      );
      if (!evaluation.valid) {
        const limit = coupon?.usageLimit != null && coupon.usedCount >= coupon.usageLimit;
        conflicts.push({
          kind: limit ? "COUPON_LIMIT_EXCEEDED" : "COUPON_INVALID",
          message: limit
            ? `Coupon ${code} was over its usage limit (${coupon!.usedCount}/${coupon!.usageLimit}) when this offline sale synced; discount ₹${order.couponDiscount} was honoured`
            : `Coupon ${code}: ${evaluation.message}; discount ₹${order.couponDiscount} was honoured`,
          detail: { code, couponDiscount: order.couponDiscount, usedCount: coupon?.usedCount ?? null, usageLimit: coupon?.usageLimit ?? null },
        });
      } else if (toPaise(evaluation.discount) !== toPaise(order.couponDiscount)) {
        conflicts.push({
          kind: "COUPON_DISCOUNT_MISMATCH",
          message: `Coupon ${code} would give ₹${evaluation.discount} now; device gave ₹${order.couponDiscount}`,
          detail: { code, server: evaluation.discount, device: order.couponDiscount },
        });
      }
      // Count the real redemption even past the limit — the usage happened.
      if (coupon && settled) await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
    }

    // ---- invoice number ----
    let billNumber: string | null = null;
    let invoice: { edgeDeviceId: string; seriesCode: string; fy: string; seq: number } | null = null;
    if (settled && order.billNo) {
      const b = order.billNo;
      let expected: string | null = null;
      try {
        expected = formatEdgeBillNumber(b.series, b.fy, b.seq);
      } catch {
        expected = null;
      }
      // An outbox can still hold bills from this terminal's previous activation
      // (older series) — accept those against the device that owned the series.
      const owner =
        b.series === device.seriesCode
          ? { id: device.edgeDeviceId }
          : await tx.edgeDevice.findFirst({ where: { tenantId, outletId, terminalId: device.terminalId, seriesCode: b.series }, select: { id: true } });
      if (!owner || expected !== b.number) {
        conflicts.push({
          kind: "BILL_SERIES_MISMATCH",
          message: `Invoice ${b.number} does not belong to this device's series; a fallback number was assigned`,
          detail: { billNo: b, deviceSeries: device.seriesCode },
        });
      } else {
        const taken = await tx.edgeInvoiceSeq.findFirst({
          where: { OR: [{ edgeDeviceId: owner.id, fiscalYear: b.fy, seq: b.seq }, { outletId, billNumber: b.number }] },
        });
        if (taken) {
          conflicts.push({
            kind: "BILL_NUMBER_DUPLICATE",
            message: `Invoice ${b.number} was already used by another order; a fallback number was assigned`,
            detail: { billNo: b, existingOrderId: taken.orderId },
          });
        } else {
          billNumber = b.number;
          invoice = { edgeDeviceId: owner.id, seriesCode: b.series, fy: b.fy, seq: b.seq };
        }
      }
    }
    if (settled && !billNumber) {
      // Legacy bill (no device series) or a rejected device number: draw from the
      // outlet's online series so the sale still carries a valid invoice number.
      const outlet = await tx.outlet.update({ where: { id: outletId }, data: { nextBillNumber: { increment: 1 } } });
      billNumber = `B-${outlet.nextBillNumber - 1}`;
    }

    // ---- the order + lines + KOT + stock ----
    const created = await tx.order.create({
      data: {
        tenantId,
        outletId,
        orderType: order.orderType,
        status: order.status,
        tableId,
        customerName: order.customerName ?? null,
        customerPhone: order.customerPhone ?? null,
        couponCode,
        deviceId: device.terminalId,
        clientId: order.clientId,
        offlineRef: order.billNo?.number ?? null,
        billNumber,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        createdById,
        createdAt,
      },
    });
    const drift = await this.insertLines(tx, device, created.id, order, createdAt, closedAt);
    if (drift.length) {
      conflicts.push({
        kind: "PRICE_DRIFT",
        message: `${drift.length} line(s) were billed at the device's cached price, which differs from the current menu`,
        detail: { lines: drift },
      });
    }

    if (invoice) {
      await tx.edgeInvoiceSeq.create({
        data: {
          tenantId,
          outletId,
          edgeDeviceId: invoice.edgeDeviceId,
          seriesCode: invoice.seriesCode,
          fiscalYear: invoice.fy,
          seq: invoice.seq,
          billNumber: billNumber!,
          orderId: created.id,
        },
      });
    }
    if (settled) {
      await tx.orderPayment.createMany({
        data: order.payments.map((p) => ({ orderId: created.id, mode: p.mode, amount: p.amount, createdAt: closedAt })),
      });
      const cash = order.payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + toPaise(p.amount), 0);
      if (cash > 0) {
        const session = await tx.cashSession.findFirst({ where: { tenantId, outletId, status: "OPEN" } });
        if (session) {
          await tx.cashMovement.create({ data: { sessionId: session.id, type: "SALE", amount: fromPaise(cash), orderId: created.id, note: billNumber } });
        }
      }
    }
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: closedById,
        action: "ORDER_SYNCED",
        entity: "order",
        entityId: created.id,
        data: {
          source: "edge",
          edgeDeviceId: device.edgeDeviceId,
          clientId: order.clientId,
          status: order.status,
          billNumber,
          deviceBillNumber: order.billNo?.number ?? null,
          payments: order.payments,
          manualDiscount: order.manualDiscount,
          couponCode,
          couponDiscount: order.couponDiscount,
          deliveryAddress: order.deliveryAddress ?? null,
          cancelReason: order.cancelReason ?? null,
          createdByStaffId: order.createdByStaffId ?? null,
          closedByStaffId: order.closedByStaffId ?? null,
          deviceCreatedAt: order.createdAt,
          deviceClosedAt: order.closedAt,
          clockSkewMs: skewMs,
        } as Prisma.InputJsonValue,
      },
    });
    if (conflicts.length) {
      await tx.edgeSyncConflict.createMany({
        data: conflicts.map((c) => ({
          tenantId,
          outletId,
          edgeDeviceId: device.edgeDeviceId,
          clientId: order.clientId,
          orderId: created.id,
          billNumber,
          kind: c.kind,
          message: c.message,
          detail: (c.detail ?? null) as Prisma.InputJsonValue,
        })),
      });
    }
    return { orderId: created.id, billNumber, conflicts };
  }

  /**
   * Writes order lines at the prices the device billed, one KOT carrying the
   * kitchen status the LAN KDS reached, and the recipe stock depletion. Returns
   * the lines whose billed price differs from today's catalog price.
   */
  private async insertLines(tx: Tx, device: EdgeDeviceContext, orderId: string, order: EdgeOrderInput, createdAt: Date, closedAt: Date) {
    const { tenantId, outletId } = device;
    const itemIds = [...new Set([...order.items.map((l) => l.itemId), ...order.combos.flatMap((c) => c.selections.map((s) => s.itemId))])];
    // Deleted items are still loaded: the sale happened while they were on the menu.
    const items = await tx.item.findMany({
      where: { id: { in: itemIds }, tenantId, outletId },
      include: {
        variations: true,
        addonGroups: { include: { group: { include: { addons: true } } } },
        category: { select: { stationId: true } },
        recipe: true,
      },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const combos = order.combos.length
      ? await tx.combo.findMany({
          where: { id: { in: order.combos.map((c) => c.comboId) }, tenantId, outletId },
          include: { slots: { orderBy: { sortOrder: "asc" }, include: { options: true } } },
        })
      : [];
    const comboMap = new Map(combos.map((c) => [c.id, c]));

    const statuses = [...order.items, ...order.combos].map((l) => l.prepStatus);
    const outlet = await tx.outlet.update({ where: { id: outletId }, data: { nextKotNumber: { increment: 1 } } });
    const kot = await tx.kot.create({
      data: {
        tenantId,
        outletId,
        orderId,
        kotNumber: outlet.nextKotNumber - 1,
        status: statuses.every((s) => s === "READY") ? "READY" : "PENDING",
        createdAt,
      },
    });
    const preppedAt = (l: { prepStatus: string; preppedAt?: string | null }) =>
      l.prepStatus === "READY" ? (l.preppedAt && !Number.isNaN(Date.parse(l.preppedAt)) ? new Date(Math.min(Date.parse(l.preppedAt), Date.now())) : closedAt) : null;

    const consumption = new Map<string, number>();
    const consume = (recipe: { rawMaterialId: string; quantity: Prisma.Decimal }[], qty: number) => {
      for (const r of recipe) consumption.set(r.rawMaterialId, (consumption.get(r.rawMaterialId) ?? 0) + Number(r.quantity) * qty);
    };
    const drift: { name: string; billed: number; current: number }[] = [];

    for (const line of order.items) {
      const item = itemMap.get(line.itemId);
      if (!item) throw new RejectOp(`Item ${line.itemId} does not exist in this outlet`);
      const variation = line.variationId ? item.variations.find((v) => v.id === line.variationId) : undefined;
      const allAddons = item.addonGroups.flatMap((g) => g.group.addons);
      const addons = line.addonIds.map((id) => allAddons.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
      const current = Number(variation ? variation.price : item.price) + addons.reduce((s, a) => s + Number(a.price), 0);
      if (toPaise(current) !== toPaise(line.unitPrice)) drift.push({ name: item.name, billed: line.unitPrice, current: fromPaise(toPaise(current)) });
      await tx.orderItem.create({
        data: {
          orderId,
          itemId: item.id,
          itemName: item.name,
          variationId: variation?.id ?? null,
          variationName: variation?.name ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: fromPaise(lineTotalPaise(line.unitPrice, line.quantity)),
          taxRate: line.taxRate,
          note: line.note ?? null,
          kotId: kot.id,
          stationId: item.category.stationId,
          prepStatus: line.prepStatus,
          preppedAt: preppedAt(line),
          addons: { create: addons.map((a) => ({ addonId: a.id, name: a.name, price: a.price })) },
        },
      });
      consume(item.recipe, line.quantity);
    }

    for (const line of order.combos) {
      const combo = comboMap.get(line.comboId);
      if (!combo) throw new RejectOp(`Combo ${line.comboId} does not exist in this outlet`);
      const chosen = combo.slots.map((slot) => {
        const sel = line.selections.find((s) => s.slotId === slot.id);
        const option = (sel && slot.options.find((o) => o.itemId === sel.itemId)) ?? slot.options.find((o) => o.isDefault) ?? slot.options[0];
        return { itemId: sel?.itemId ?? option?.itemId, priceDelta: option ? Number(option.priceDelta) : 0 };
      });
      const current = Number(combo.price) + chosen.reduce((s, c) => s + c.priceDelta, 0);
      if (toPaise(current) !== toPaise(line.unitPrice)) drift.push({ name: combo.name, billed: line.unitPrice, current: fromPaise(toPaise(current)) });
      const comboGroupId = `${orderId}:${order.combos.indexOf(line)}`;
      await tx.orderItem.create({
        data: {
          orderId,
          itemId: combo.id,
          itemName: combo.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: fromPaise(lineTotalPaise(line.unitPrice, line.quantity)),
          taxRate: line.taxRate,
          note: line.note ?? null,
          comboId: combo.id,
          comboGroupId,
          isComboComponent: false,
          prepStatus: line.prepStatus,
          preppedAt: preppedAt(line),
        },
      });
      for (const c of chosen) {
        const item = c.itemId ? itemMap.get(c.itemId) ?? (await tx.item.findFirst({ where: { id: c.itemId, tenantId, outletId }, include: { category: { select: { stationId: true } }, recipe: true } })) : null;
        if (!item) continue; // a component removed from the catalog: the parent line still carries the money
        await tx.orderItem.create({
          data: {
            orderId,
            itemId: item.id,
            itemName: item.name,
            quantity: line.quantity,
            unitPrice: 0,
            lineTotal: 0,
            taxRate: item.taxRate,
            kotId: kot.id,
            stationId: item.category.stationId,
            comboId: combo.id,
            comboGroupId,
            isComboComponent: true,
            prepStatus: line.prepStatus,
            preppedAt: preppedAt(line),
          },
        });
        consume(item.recipe, line.quantity);
      }
    }

    for (const [rawMaterialId, qty] of consumption) {
      const owned = await tx.rawMaterial.updateMany({ where: { id: rawMaterialId, tenantId, outletId }, data: { stockQty: { decrement: qty } } });
      if (!owned.count) continue;
      await tx.stockMovement.create({
        data: { tenantId, outletId, rawMaterialId, type: "CONSUMPTION", quantity: -qty, refType: "kot", refId: kot.id },
      });
    }
    return drift;
  }

  // ---------- kitchen status reconciliation ----------

  /**
   * A LAN KDS bumped a ticket after its order had already synced. Lines are
   * addressed by their index in the device order (items, then combos), which
   * maps onto the server lines in insertion order.
   */
  private async applyKotStatus(device: EdgeDeviceContext, op: Extract<EdgeOutboxOp, { kind: "KOT_STATUS" }>): Promise<EdgeOpResultDto> {
    const order = await this.prisma.order.findFirst({
      where: { tenantId: device.tenantId, outletId: device.outletId, deviceId: device.terminalId, clientId: op.clientId },
    });
    if (!order) return { key: op.key, status: "retry", message: "Order has not synced yet" };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
        const lines = await tx.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
        const plain = lines.filter((l) => !l.comboId);
        const parents = lines.filter((l) => l.comboId && !l.isComboComponent);
        for (const s of op.lines) {
          const target = s.kind === "item" ? plain[s.lineIndex] : parents[s.lineIndex];
          if (!target) continue;
          const preppedAt = s.prepStatus === "READY" ? (s.preppedAt && !Number.isNaN(Date.parse(s.preppedAt)) ? new Date(Math.min(Date.parse(s.preppedAt), Date.now())) : new Date()) : null;
          const ids = target.comboGroupId ? lines.filter((l) => l.comboGroupId === target.comboGroupId).map((l) => l.id) : [target.id];
          await tx.orderItem.updateMany({ where: { id: { in: ids } }, data: { prepStatus: s.prepStatus, preppedAt } });
        }
        const kots = await tx.kot.findMany({ where: { orderId: order.id }, include: { items: true } });
        for (const k of kots) {
          await tx.kot.update({ where: { id: k.id }, data: { status: k.items.every((i) => i.prepStatus === "READY") ? "READY" : "PENDING" } });
        }
      });
    } catch (err) {
      this.log.warn(`edge KOT status ${op.clientId} not applied: ${err instanceof Error ? err.message : err}`);
      return { key: op.key, status: "retry", message: "Temporary server error" };
    }
    this.realtime.notifyOutlet(device.outletId);
    return { key: op.key, status: "applied", serverId: order.id, billNumber: order.billNumber };
  }
}
