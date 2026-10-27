import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  LineQtyInput,
  MergeOrdersInput,
  OrderDto,
  SplitOrderInput,
  TransferOrderInput,
} from "@stello/shared";
import { allocatePaise, fromPaise, lineTotalPaise, splitLinesEqually, toPaise } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { OrdersService } from "../orders/orders.service";

type Tx = Prisma.TransactionClient;
type LineRow = Prisma.OrderItemGetPayload<{ include: { addons: true } }>;
type OrderRow = Prisma.OrderGetPayload<object>;

/**
 * Running-bill operations on top of OrdersService: merge, table/item transfer,
 * split into checks, and per-bill service-charge removal.
 *
 * Locking (see docs/implementation-2026-09-21/RESULTS.md): every operation takes
 * the dining-table row locks it needs FIRST (sorted by id), then order row locks
 * (sorted by id; split checks before their parent). Order creation, scan
 * ingestion and these operations all lock table → order, and settlement of a
 * split check locks check → parent, so concurrent operations serialize instead
 * of deadlocking or double-moving lines.
 */
@Injectable()
export class OrderOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly orders: OrdersService,
  ) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  /** Lock orders in id order and return them re-read under the lock. */
  private async lockOrders(tx: Tx, user: AuthUser, ids: string[]): Promise<Map<string, OrderRow>> {
    const sorted = [...new Set(ids)].sort();
    for (const id of sorted) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${id} AND "tenantId" = ${user.tenantId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Order not found");
    }
    const rows = await tx.order.findMany({ where: { id: { in: sorted }, tenantId: user.tenantId } });
    for (const r of rows) this.assertOutlet(user, r.outletId);
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async lockTables(tx: Tx, user: AuthUser, outletId: string, tableIds: (string | null | undefined)[]) {
    const sorted = [...new Set(tableIds.filter((t): t is string => !!t))].sort();
    for (const id of sorted) await this.orders.lockTable(tx, user.tenantId, outletId, id);
  }

  private assertMergeable(o: OrderRow, label: string) {
    if (o.status !== "OPEN") throw new BadRequestException(`${label} is not open`);
    this.orders.assertNotSplit(o, "move it");
  }

  private async audit(tx: Tx, user: AuthUser, action: string, entityId: string, data: Prisma.InputJsonValue) {
    await tx.auditLog.create({ data: { tenantId: user.tenantId, userId: user.id, action, entity: "order", entityId, data } });
  }

  // ---------- Service charge ----------

  /** Waive (or restore) the service charge on one running bill, with a reason. */
  async setServiceCharge(user: AuthUser, orderId: string, waive: boolean, reason?: string): Promise<OrderDto> {
    const outletId = await this.prisma.$transaction(async (tx) => {
      const order = await this.orders.lockOpenOrder(tx, user, orderId);
      if (order.splitCount) throw new BadRequestException("This bill is split — change the service charge on each check");
      const before = Number(order.serviceChargeAmount);
      await tx.order.update({
        where: { id: order.id },
        data: { serviceChargeWaived: waive, serviceChargeWaivedReason: waive ? (reason ?? null) : null },
      });
      const after = await this.orders.recomputeTotals(tx, order.id);
      await this.audit(tx, user, waive ? "SERVICE_CHARGE_REMOVED" : "SERVICE_CHARGE_RESTORED", order.id, {
        reason: reason ?? null,
        before,
        after: Number(after.serviceChargeAmount),
      });
      return order.outletId;
    });
    this.realtime.notifyOutlet(outletId);
    return this.orders.getOne(user, orderId);
  }

  // ---------- Merge ----------

  /** Fold one or more running bills into `targetId` (e.g. joining tables). */
  async merge(user: AuthUser, targetId: string, input: MergeOrdersInput): Promise<OrderDto> {
    const sourceIds = [...new Set(input.sourceOrderIds)];
    if (sourceIds.includes(targetId)) throw new BadRequestException("Cannot merge an order into itself");
    const all = [targetId, ...sourceIds];
    // Unlocked read only to discover which tables to lock; re-validated below.
    const pre = await this.prisma.order.findMany({ where: { id: { in: all }, tenantId: user.tenantId } });
    if (pre.length !== all.length) throw new NotFoundException("Order not found");
    const outletId = pre[0].outletId;
    if (pre.some((o) => o.outletId !== outletId)) throw new BadRequestException("Orders belong to different outlets");
    this.assertOutlet(user, outletId);

    await this.prisma.$transaction(async (tx) => {
      await this.lockTables(tx, user, outletId, pre.map((o) => o.tableId));
      const locked = await this.lockOrders(tx, user, all);
      const target = locked.get(targetId)!;
      this.assertMergeable(target, "Target order");
      for (const id of sourceIds) {
        const src = locked.get(id)!;
        if (src.outletId !== outletId) throw new BadRequestException("Orders belong to different outlets");
        this.assertMergeable(src, "Source order");
      }
      await this.moveAll(tx, sourceIds, target);
      await this.orders.recomputeTotals(tx, target.id);
      await this.audit(tx, user, "ORDER_MERGED", target.id, {
        sources: sourceIds,
        sourceTables: sourceIds.map((id) => locked.get(id)!.tableId),
      });
      for (const id of sourceIds) await this.audit(tx, user, "ORDER_MERGED_INTO", id, { target: target.id });
    });
    this.realtime.notifyOutlet(outletId);
    return this.orders.getOne(user, targetId);
  }

  /** Move every line + KOT of `sourceIds` into `target` and close the sources as MERGED. */
  private async moveAll(tx: Tx, sourceIds: string[], target: OrderRow) {
    await tx.orderItem.updateMany({ where: { orderId: { in: sourceIds } }, data: { orderId: target.id } });
    // KOTs keep their numbers (the kitchen's printed tickets stay valid); they now
    // belong to the surviving bill.
    await tx.kot.updateMany({ where: { orderId: { in: sourceIds } }, data: { orderId: target.id } });
    await tx.orderRequest.updateMany({ where: { orderId: { in: sourceIds } }, data: { orderId: target.id } });
    await tx.parkedCart.updateMany({ where: { orderId: { in: sourceIds } }, data: { orderId: target.id } });
    if (!target.customerPhone || !target.customerName) {
      const donor = await tx.order.findFirst({
        where: { id: { in: sourceIds }, OR: [{ customerPhone: { not: null } }, { customerName: { not: null } }] },
      });
      if (donor) {
        await tx.order.update({
          where: { id: target.id },
          data: {
            customerName: target.customerName ?? donor.customerName,
            customerPhone: target.customerPhone ?? donor.customerPhone,
          },
        });
      }
    }
    await tx.order.updateMany({
      where: { id: { in: sourceIds } },
      data: { status: "MERGED", mergedIntoOrderId: target.id, subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0, serviceChargeAmount: 0, roundOff: 0, version: { increment: 1 } },
    });
  }

  // ---------- Transfer ----------

  /**
   * Move a running bill to another table, or move selected lines (optionally
   * part of a line's quantity) to another table's running bill — opening one
   * there if the table is free.
   */
  async transfer(user: AuthUser, orderId: string, input: TransferOrderInput): Promise<{ from: OrderDto | null; to: OrderDto }> {
    const pre = await this.orders.requireOrder(user, orderId);
    if (pre.tableId === input.toTableId) throw new BadRequestException("The order is already on that table");

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockTables(tx, user, pre.outletId, [pre.tableId, input.toTableId]);
      const source = (await this.lockOrders(tx, user, [orderId])).get(orderId)!;
      this.assertMergeable(source, "Order");
      if (source.tableId !== pre.tableId) throw new BadRequestException("The order moved tables meanwhile; refresh and retry");
      const targetTable = await tx.diningTable.findFirstOrThrow({ where: { id: input.toTableId, tenantId: user.tenantId } });

      const existing = await tx.order.findFirst({
        where: { tenantId: user.tenantId, outletId: source.outletId, tableId: input.toTableId, status: "OPEN" },
      });
      let target: OrderRow | null = null;
      if (existing) {
        target = (await this.lockOrders(tx, user, [existing.id])).get(existing.id)!;
        this.assertMergeable(target, `${targetTable.name}'s bill`);
      }

      const lines = await tx.orderItem.findMany({ where: { orderId: source.id }, include: { addons: true } });
      const moves = input.lines ? this.resolveMoves(lines, input.lines) : null;
      const movesEverything = !moves || lines.every((l) => (moves.get(l.id) ?? 0) === l.quantity);

      if (movesEverything) {
        if (target) {
          // Moving the whole bill onto an occupied table is a merge.
          await this.moveAll(tx, [source.id], target);
          await this.orders.recomputeTotals(tx, target.id);
          await this.audit(tx, user, "ORDER_MERGED", target.id, { sources: [source.id], sourceTables: [source.tableId], via: "transfer" });
          await this.audit(tx, user, "ORDER_MERGED_INTO", source.id, { target: target.id });
          return { fromId: null, toId: target.id, outletId: source.outletId };
        }
        await tx.order.update({
          where: { id: source.id },
          data: { tableId: input.toTableId, orderType: "DINE_IN", version: { increment: 1 } },
        });
        await this.orders.recomputeTotals(tx, source.id);
        await this.audit(tx, user, "ORDER_TABLE_TRANSFERRED", source.id, { fromTableId: source.tableId, toTableId: input.toTableId });
        return { fromId: null, toId: source.id, outletId: source.outletId };
      }

      if (!target) {
        target = await tx.order.create({
          data: {
            tenantId: user.tenantId,
            outletId: source.outletId,
            orderType: "DINE_IN",
            tableId: input.toTableId,
            createdById: user.id,
          },
        });
      }
      const touchedKots = new Set<string>();
      for (const line of lines) {
        const qty = moves!.get(line.id) ?? 0;
        if (qty === 0) continue;
        if (line.kotId) touchedKots.add(line.kotId);
        await this.moveLine(tx, line, qty, target.id);
      }
      // A KOT whose items all moved follows them; a partly-moved KOT stays with the
      // source bill (its number is unchanged either way, so printed KOTs stay valid).
      for (const kotId of touchedKots) {
        const left = await tx.orderItem.count({ where: { kotId, orderId: source.id } });
        if (left === 0) await tx.kot.updateMany({ where: { id: kotId }, data: { orderId: target.id } });
      }
      await this.orders.recomputeTotals(tx, source.id);
      await this.orders.recomputeTotals(tx, target.id);
      await this.audit(tx, user, "ORDER_ITEMS_TRANSFERRED", source.id, {
        toOrderId: target.id,
        toTableId: input.toTableId,
        lines: input.lines as unknown as Prisma.InputJsonValue,
      });
      return { fromId: source.id, toId: target.id, outletId: source.outletId };
    });
    this.realtime.notifyOutlet(result.outletId);
    return {
      from: result.fromId ? await this.orders.getOne(user, result.fromId) : null,
      to: await this.orders.getOne(user, result.toId),
    };
  }

  /**
   * Expand requested (line, qty) moves to every row that must move: a combo's
   * parent line carries its zero-priced component lines in proportion.
   */
  private resolveMoves(lines: LineRow[], requested: LineQtyInput[]): Map<string, number> {
    const byId = new Map(lines.map((l) => [l.id, l]));
    const moves = new Map<string, number>();
    for (const req of requested) {
      const line = byId.get(req.orderItemId);
      if (!line) throw new BadRequestException("A selected line is not on this bill");
      if (line.isComboComponent) throw new BadRequestException("Select the combo, not its component");
      if (moves.has(line.id)) throw new BadRequestException("A line was selected twice");
      if (req.quantity > line.quantity) throw new BadRequestException(`Only ${line.quantity} × ${line.itemName} on this bill`);
      moves.set(line.id, req.quantity);
      if (line.comboGroupId) {
        for (const comp of lines.filter((l) => l.isComboComponent && l.comboGroupId === line.comboGroupId)) {
          const q = (comp.quantity * req.quantity) / line.quantity;
          if (!Number.isInteger(q)) throw new BadRequestException(`${line.itemName} cannot be divided that way`);
          moves.set(comp.id, q);
        }
      }
    }
    return moves;
  }

  /** Move `qty` of a line to another order, splitting the row when partial. */
  private async moveLine(tx: Tx, line: LineRow, qty: number, targetOrderId: string) {
    if (qty === line.quantity) {
      await tx.orderItem.update({ where: { id: line.id }, data: { orderId: targetOrderId } });
      return;
    }
    const unit = Number(line.unitPrice);
    await tx.orderItem.update({
      where: { id: line.id },
      data: { quantity: line.quantity - qty, lineTotal: fromPaise(lineTotalPaise(unit, line.quantity - qty)) },
    });
    await tx.orderItem.create({ data: this.copyLine(line, targetOrderId, { quantity: qty, lineTotal: fromPaise(lineTotalPaise(unit, qty)) }) });
  }

  private copyLine(
    line: LineRow,
    orderId: string,
    over: Partial<Prisma.OrderItemUncheckedCreateInput> & { quantity: number; lineTotal: number },
  ): Prisma.OrderItemUncheckedCreateInput {
    return {
      orderId,
      itemId: line.itemId,
      itemName: line.itemName,
      variationId: line.variationId,
      variationName: line.variationName,
      unitPrice: line.unitPrice,
      taxRate: line.taxRate,
      note: line.note,
      kotId: line.kotId,
      stationId: line.stationId,
      prepStatus: line.prepStatus,
      preppedAt: line.preppedAt,
      comboId: line.comboId,
      comboGroupId: line.comboGroupId,
      isComboComponent: line.isComboComponent,
      addons: { create: line.addons.map((a) => ({ addonId: a.addonId, name: a.name, price: a.price })) },
      ...over,
    };
  }

  // ---------- Split ----------

  /**
   * Split a running bill into checks. The parent keeps its lines and KOTs (the
   * kitchen is unaffected); each check gets billing copies of its share and
   * settles independently with its own bill number. The parent closes (status
   * SPLIT) when the last check settles.
   *
   * - ITEMS: each line's quantity is assigned across checks (all of it).
   * - EQUAL: every line is shared 1/N; paise are divided exactly per line.
   * An optional bill-level discount is allocated across checks pro rata.
   */
  async split(user: AuthUser, orderId: string, input: SplitOrderInput): Promise<OrderDto> {
    const outletId = await this.prisma.$transaction(async (tx) => {
      const parent = await this.orders.lockOpenOrder(tx, user, orderId);
      if (parent.splitCount) throw new BadRequestException("This bill is already split");
      if (parent.parentOrderId) throw new BadRequestException("A split check cannot be split again");
      const lines = await tx.orderItem.findMany({ where: { orderId: parent.id }, include: { addons: true }, orderBy: { id: "asc" } });
      if (!lines.some((l) => !l.isComboComponent)) throw new BadRequestException("Nothing to split");

      // checks[c] = the rows to create for check c.
      const checks: Prisma.OrderItemUncheckedCreateInput[][] = [];
      if (input.mode === "EQUAL") {
        const shares = splitLinesEqually(lines.map((l) => toPaise(Number(l.lineTotal))), input.parts);
        for (let c = 0; c < input.parts; c++) {
          checks.push(
            lines.map((l, i) =>
              this.copyLine(l, "", {
                quantity: l.quantity,
                lineTotal: fromPaise(shares[c][i]),
                kotId: null,
                splitFromItemId: l.id,
                splitParts: input.parts,
              }),
            ),
          );
        }
      } else {
        const assigned = new Map<string, number>();
        for (const check of input.checks) {
          const moves = this.resolveMoves(lines, check.lines);
          const rows: Prisma.OrderItemUncheckedCreateInput[] = [];
          for (const l of lines) {
            const q = moves.get(l.id);
            if (!q) continue;
            assigned.set(l.id, (assigned.get(l.id) ?? 0) + q);
            rows.push(
              this.copyLine(l, "", {
                quantity: q,
                lineTotal: fromPaise(lineTotalPaise(Number(l.unitPrice), q)),
                kotId: null,
                splitFromItemId: l.id,
              }),
            );
          }
          checks.push(rows);
        }
        for (const l of lines) {
          const got = assigned.get(l.id) ?? 0;
          if (got !== l.quantity) {
            throw new BadRequestException(
              got > l.quantity
                ? `${l.itemName}: ${got} assigned but only ${l.quantity} on the bill`
                : `${l.itemName}: assign all ${l.quantity} to a check (${got} assigned)`,
            );
          }
        }
      }

      const checkSubtotals = checks.map((rows) => rows.reduce((s, r) => s + toPaise(Number(r.lineTotal)), 0));
      const subtotalPaise = checkSubtotals.reduce((s, x) => s + x, 0);
      const discountPaise = Math.min(toPaise(input.discountAmount ?? 0), subtotalPaise);
      const discounts = allocatePaise(discountPaise, checkSubtotals);

      const childIds: string[] = [];
      for (let c = 0; c < checks.length; c++) {
        const child = await tx.order.create({
          data: {
            tenantId: user.tenantId,
            outletId: parent.outletId,
            orderType: parent.orderType,
            tableId: null, // the parent keeps the table; checks are found via parentOrderId
            customerName: parent.customerName,
            customerPhone: parent.customerPhone,
            createdById: user.id,
            parentOrderId: parent.id,
            splitIndex: c + 1,
            allocatedDiscount: fromPaise(discounts[c]),
            serviceChargeWaived: parent.serviceChargeWaived,
            serviceChargeWaivedReason: parent.serviceChargeWaivedReason,
          },
        });
        for (const row of checks[c]) await tx.orderItem.create({ data: { ...row, orderId: child.id } });
        await this.orders.recomputeTotals(tx, child.id);
        childIds.push(child.id);
      }
      await tx.order.update({ where: { id: parent.id }, data: { splitCount: checks.length, version: { increment: 1 } } });
      await this.audit(tx, user, "ORDER_SPLIT", parent.id, {
        mode: input.mode,
        checks: childIds,
        discount: fromPaise(discountPaise),
      });
      return parent.outletId;
    });
    this.realtime.notifyOutlet(outletId);
    return this.orders.getOne(user, orderId);
  }

  /** Undo a split while no check has settled: delete the checks, reopen the parent. */
  async unsplit(user: AuthUser, orderId: string): Promise<OrderDto> {
    const pre = await this.orders.requireOrder(user, orderId);
    const preChildren = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, parentOrderId: pre.id },
      select: { id: true },
    });
    const outletId = await this.prisma.$transaction(async (tx) => {
      // Checks before parent — the same order a check's settlement locks in.
      await this.lockOrders(tx, user, preChildren.map((c) => c.id));
      const parent = await this.orders.lockOpenOrder(tx, user, orderId);
      if (!parent.splitCount) throw new BadRequestException("This bill is not split");
      const children = await tx.order.findMany({ where: { tenantId: user.tenantId, parentOrderId: parent.id } });
      if (children.length !== preChildren.length) throw new BadRequestException("The split changed meanwhile; refresh and retry");
      if (children.some((c) => c.status !== "OPEN")) {
        throw new BadRequestException("A check has already been settled — the split can no longer be undone");
      }
      const ids = children.map((c) => c.id);
      await tx.orderItemAddon.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
      await tx.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await tx.parkedCart.deleteMany({ where: { orderId: { in: ids } } });
      await tx.order.deleteMany({ where: { id: { in: ids }, tenantId: user.tenantId } });
      await tx.order.update({ where: { id: parent.id }, data: { splitCount: null, version: { increment: 1 } } });
      await this.orders.recomputeTotals(tx, parent.id);
      await this.audit(tx, user, "ORDER_UNSPLIT", parent.id, { removedChecks: ids });
      return parent.outletId;
    });
    this.realtime.notifyOutlet(outletId);
    return this.orders.getOne(user, orderId);
  }
}
