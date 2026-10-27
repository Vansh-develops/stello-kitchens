import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  canEditPo,
  canReceivePo,
  lineAmountsPaise,
  maxReceivable,
  nextPoStatus,
  poActionsFor,
  priceVariance,
  statusAfterReceipt,
  unitFactor,
  type AuthUser,
  type CreatePurchaseOrderInput,
  type GoodsReceiptDto,
  type MaterialUnit,
  type PoActionInput,
  type PoLineInput,
  type PoStatus,
  type PriceHistoryRowDto,
  type ProcurementSettingsDto,
  type ProcurementSettingsInput,
  type ProcurementVendorDto,
  type ProcurementVendorInput,
  type PurchaseOrderDto,
  type PurchaseOrderSummaryDto,
  type ReceiveGrnInput,
  type UpdatePurchaseOrderInput,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { InventoryService } from "../inventory/inventory.service";
import { D, assertOutlet, nextDocNumber, parseDay, round2, round3, round4 } from "./procurement.common";

const can = (user: AuthUser, perm: string) => user.permissions.includes("*") || user.permissions.includes(perm);

type ResolvedLine = {
  rawMaterialId: string;
  materialName: string;
  unit: MaterialUnit;
  unitFactor: number;
  orderedQty: number;
  rate: number;
  taxRate: number;
  sortOrder: number;
};

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly inventory: InventoryService,
  ) {}

  // ---------- Settings ----------

  async getSettings(user: AuthUser, outletId: string): Promise<ProcurementSettingsDto> {
    assertOutlet(user, outletId);
    const s = await this.prisma.procurementSettings.findFirst({ where: { tenantId: user.tenantId, outletId } });
    return {
      overReceiptPct: D(s?.overReceiptPct ?? 0),
      priceVarianceAlertPct: D(s?.priceVarianceAlertPct ?? 5),
      coverDays: s?.coverDays ?? 3,
      leadDays: s?.leadDays ?? 1,
      lookbackDays: s?.lookbackDays ?? 28,
    };
  }

  async saveSettings(user: AuthUser, outletId: string, input: ProcurementSettingsInput) {
    assertOutlet(user, outletId);
    const existing = await this.prisma.procurementSettings.findFirst({ where: { tenantId: user.tenantId, outletId } });
    if (existing) {
      await this.prisma.procurementSettings.update({ where: { id: existing.id }, data: input });
    } else {
      await this.prisma.procurementSettings.create({ data: { tenantId: user.tenantId, outletId, ...input } });
    }
    return this.getSettings(user, outletId);
  }

  // ---------- Vendors (full profile) ----------

  async listVendors(user: AuthUser, outletId: string): Promise<ProcurementVendorDto[]> {
    assertOutlet(user, outletId);
    const vendors = await this.prisma.vendor.findMany({
      where: { tenantId: user.tenantId, outletId, deletedAt: null },
      orderBy: { name: "asc" },
    });
    return vendors.map((v) => this.toVendorDto(v));
  }

  async createVendor(user: AuthUser, outletId: string, input: ProcurementVendorInput) {
    assertOutlet(user, outletId);
    const v = await this.prisma.vendor.create({
      data: { tenantId: user.tenantId, outletId, ...this.vendorData(input) },
    });
    return { id: v.id };
  }

  async updateVendor(user: AuthUser, outletId: string, id: string, input: ProcurementVendorInput) {
    await this.requireVendor(user, outletId, id);
    await this.prisma.vendor.update({ where: { id }, data: this.vendorData(input) });
    return { id };
  }

  private vendorData(input: ProcurementVendorInput) {
    return {
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      gstin: input.gstin ? input.gstin.toUpperCase() : null,
      address: input.address ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
    };
  }

  private toVendorDto(v: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    gstin: string | null;
    address: string | null;
    paymentTermsDays: number | null;
  }): ProcurementVendorDto {
    return {
      id: v.id,
      name: v.name,
      phone: v.phone,
      email: v.email,
      gstin: v.gstin,
      address: v.address,
      paymentTermsDays: v.paymentTermsDays,
    };
  }

  private async requireVendor(user: AuthUser, outletId: string, id: string) {
    assertOutlet(user, outletId);
    const v = await this.prisma.vendor.findFirst({ where: { id, tenantId: user.tenantId, outletId, deletedAt: null } });
    if (!v) throw new BadRequestException("Vendor not found in this outlet");
    return v;
  }

  // ---------- Purchase orders ----------

  async list(user: AuthUser, outletId: string, status?: string): Promise<PurchaseOrderSummaryDto[]> {
    assertOutlet(user, outletId);
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { tenantId: user.tenantId, outletId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { vendor: true, lines: true },
    });
    return pos.map((po) => this.toSummary(po));
  }

  async get(user: AuthUser, outletId: string, id: string): Promise<PurchaseOrderDto> {
    assertOutlet(user, outletId);
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId, outletId },
      include: {
        vendor: true,
        lines: { orderBy: { sortOrder: "asc" }, include: { material: true } },
        receipts: { orderBy: { receivedAt: "asc" }, include: { lines: { include: { poLine: true } } } },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    const outlet = await this.prisma.outlet.findFirstOrThrow({ where: { id: outletId, tenantId: user.tenantId } });
    const settings = await this.getSettings(user, outletId);
    const summary = this.toSummary(po);
    return {
      ...summary,
      note: po.note,
      subtotal: D(po.subtotal),
      taxAmount: D(po.taxAmount),
      vendor: this.toVendorDto(po.vendor),
      outlet: { name: outlet.name, address: outlet.address, gstin: outlet.gstin },
      lines: po.lines.map((l) => {
        const { basePaise, taxPaise } = lineAmountsPaise(D(l.orderedQty), D(l.rate), D(l.taxRate));
        return {
          id: l.id,
          rawMaterialId: l.rawMaterialId,
          materialName: l.materialName,
          materialUnit: l.material.unit as MaterialUnit,
          unit: l.unit as MaterialUnit,
          unitFactor: D(l.unitFactor),
          orderedQty: D(l.orderedQty),
          receivedQty: D(l.receivedQty),
          pendingQty: Math.max(0, round3(D(l.orderedQty) - D(l.receivedQty))),
          rate: D(l.rate),
          taxRate: D(l.taxRate),
          amount: basePaise / 100,
          taxAmount: taxPaise / 100,
        };
      }),
      receipts: po.receipts.map((r) => this.toReceiptDto(r, po.poNumber, po.vendor.name)),
      allowedActions: poActionsFor(po.status as PoStatus),
      approvedAt: po.approvedAt?.toISOString() ?? null,
      sentAt: po.sentAt?.toISOString() ?? null,
      overReceiptPct: settings.overReceiptPct,
    };
  }

  async create(user: AuthUser, outletId: string, input: CreatePurchaseOrderInput) {
    assertOutlet(user, outletId);
    await this.requireVendor(user, outletId, input.vendorId);
    const lines = await this.resolveLines(user, outletId, input.lines);
    const totals = this.totals(lines);
    const po = await this.prisma.$transaction(async (tx) => {
      const poNumber = await nextDocNumber(tx, outletId, "PO", () =>
        tx.purchaseOrder.count({ where: { outletId } }),
      );
      return tx.purchaseOrder.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          vendorId: input.vendorId,
          poNumber,
          expectedDate: input.expectedDate ? parseDay(input.expectedDate) : null,
          note: input.note ?? null,
          ...totals,
          createdById: user.id,
          lines: { create: lines.map((l) => ({ ...l, tenantId: user.tenantId })) },
        },
      });
    });
    return { id: po.id, poNumber: po.poNumber };
  }

  async update(user: AuthUser, outletId: string, id: string, input: UpdatePurchaseOrderInput) {
    assertOutlet(user, outletId);
    if (input.vendorId) await this.requireVendor(user, outletId, input.vendorId);
    const lines = input.lines ? await this.resolveLines(user, outletId, input.lines) : null;
    await this.prisma.$transaction(async (tx) => {
      const po = await this.lockPo(tx, user, outletId, id);
      if (!canEditPo(po.status as PoStatus)) throw new BadRequestException(`A ${po.status} PO can't be edited`);
      if (lines) {
        await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
        await tx.purchaseOrderLine.createMany({
          data: lines.map((l) => ({ ...l, tenantId: user.tenantId, purchaseOrderId: id })),
        });
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          vendorId: input.vendorId,
          expectedDate:
            input.expectedDate === undefined ? undefined : input.expectedDate ? parseDay(input.expectedDate) : null,
          note: input.note === undefined ? undefined : input.note,
          ...(lines ? this.totals(lines) : {}),
        },
      });
    });
    return { id };
  }

  /** approve (needs purchase.approve) · send · cancel · close — via the shared state machine. */
  async act(user: AuthUser, outletId: string, id: string, input: PoActionInput) {
    assertOutlet(user, outletId);
    if (input.action === "approve" && !can(user, "purchase.approve")) {
      throw new ForbiddenException("Approving purchase orders needs the purchase.approve permission");
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const po = await this.lockPo(tx, user, outletId, id);
      const to = nextPoStatus(po.status as PoStatus, input.action);
      if (!to) throw new BadRequestException(`Can't ${input.action} a PO that is ${po.status.toLowerCase().replace("_", " ")}`);
      const now = new Date();
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: to,
          ...(input.action === "approve" ? { approvedById: user.id, approvedAt: now } : {}),
          ...(input.action === "send" ? { sentAt: now } : {}),
          ...(input.action === "close" ? { closedAt: now } : {}),
          ...(input.action === "cancel" ? { cancelledAt: now, cancelReason: input.reason ?? null } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: `PO_${input.action.toUpperCase()}`,
          entity: "PurchaseOrder",
          entityId: id,
          data: { from: po.status, to, reason: input.reason ?? null },
        },
      });
      return { id, status: to };
    });
    return result;
  }

  // ---------- Goods receipt (GRN) ----------

  async receive(user: AuthUser, outletId: string, id: string, input: ReceiveGrnInput) {
    assertOutlet(user, outletId);
    if (input.createBill && !input.invoiceNo?.trim()) {
      throw new BadRequestException("Enter the vendor invoice number to book a bill");
    }
    const settings = await this.getSettings(user, outletId);
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockPo(tx, user, outletId, id);
      if (!canReceivePo(locked.status as PoStatus)) {
        throw new BadRequestException(`Can't receive against a ${locked.status.toLowerCase().replace("_", " ")} PO`);
      }
      const po = await tx.purchaseOrder.findFirstOrThrow({
        where: { id, tenantId: user.tenantId, outletId },
        include: { lines: true, vendor: true },
      });
      const byId = new Map(po.lines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      const receipts = input.lines
        .filter((l) => l.quantity > 0)
        .map((l) => {
          const line = byId.get(l.poLineId);
          if (!line) throw new BadRequestException("Receipt line does not belong to this PO");
          if (seen.has(l.poLineId)) throw new BadRequestException("Duplicate receipt line");
          seen.add(l.poLineId);
          const max = maxReceivable(D(line.orderedQty), D(line.receivedQty), settings.overReceiptPct);
          if (l.quantity > max + 1e-9) {
            throw new BadRequestException(
              `Over-receipt on ${line.materialName}: at most ${max} ${line.unit} can still be received` +
                (settings.overReceiptPct ? ` (${settings.overReceiptPct}% tolerance)` : ""),
            );
          }
          return { line, quantity: l.quantity, rate: l.rate ?? D(line.rate) };
        });
      if (!receipts.length) throw new BadRequestException("Enter a received quantity on at least one line");

      const grnNumber = await nextDocNumber(tx, outletId, "GRN", () =>
        tx.goodsReceipt.count({ where: { outletId } }),
      );
      const grn = await tx.goodsReceipt.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          purchaseOrderId: id,
          vendorId: po.vendorId,
          grnNumber,
          invoiceNo: input.invoiceNo?.trim() || null,
          note: input.note ?? null,
          createdById: user.id,
        },
      });

      let basePaise = 0;
      let taxPaise = 0;
      let variance = 0;
      // Lock materials in a stable order so concurrent receipts can't deadlock.
      for (const r of [...receipts].sort((a, b) => a.line.rawMaterialId.localeCompare(b.line.rawMaterialId))) {
        const factor = D(r.line.unitFactor) || 1;
        const amounts = lineAmountsPaise(r.quantity, r.rate, D(r.line.taxRate));
        basePaise += amounts.basePaise;
        taxPaise += amounts.taxPaise;
        const pv = priceVariance(D(r.line.rate), r.rate, r.quantity);
        variance += pv.amount;
        const stockQty = round3(r.quantity * factor);
        // Inventory is valued ex-GST (input tax credit), per material unit.
        const unitCost = round4(r.rate / factor);
        await this.inventory.applyReceiptTx(tx, user, outletId, r.line.rawMaterialId, {
          quantity: stockQty,
          unitCost,
          vendorId: po.vendorId,
          refType: "grn",
          refId: grn.id,
          reason: `${grnNumber} against ${po.poNumber}`,
        });
        await tx.goodsReceiptLine.create({
          data: {
            tenantId: user.tenantId,
            goodsReceiptId: grn.id,
            purchaseOrderLineId: r.line.id,
            rawMaterialId: r.line.rawMaterialId,
            quantity: r.quantity,
            rate: r.rate,
            poRate: r.line.rate,
            taxRate: r.line.taxRate,
            stockQty,
            unitCost,
            lineTotal: (amounts.basePaise + amounts.taxPaise) / 100,
            priceVariance: pv.amount,
          },
        });
        await tx.purchaseOrderLine.update({
          where: { id: r.line.id },
          data: { receivedQty: { increment: r.quantity } },
        });
      }

      const after = po.lines.map((l) => ({
        orderedQty: D(l.orderedQty),
        receivedQty: D(l.receivedQty) + (receipts.find((r) => r.line.id === l.id)?.quantity ?? 0),
      }));
      const status = statusAfterReceipt(after);
      await tx.purchaseOrder.update({ where: { id }, data: { status } });
      const total = (basePaise + taxPaise) / 100;
      await tx.goodsReceipt.update({
        where: { id: grn.id },
        data: { subtotal: basePaise / 100, taxAmount: taxPaise / 100, total, varianceAmount: round2(variance) },
      });

      let billId: string | null = null;
      if (input.createBill) {
        const billDate = new Date();
        const due = input.billDueDate
          ? parseDay(input.billDueDate)
          : po.vendor.paymentTermsDays != null
            ? new Date(billDate.getTime() + po.vendor.paymentTermsDays * 86400000)
            : null;
        const dupe = await tx.supplierBill.findFirst({
          where: { vendorId: po.vendorId, billNumber: input.invoiceNo!.trim() },
        });
        if (dupe) throw new BadRequestException(`Bill ${input.invoiceNo} is already booked for this vendor`);
        const bill = await tx.supplierBill.create({
          data: {
            tenantId: user.tenantId,
            outletId,
            vendorId: po.vendorId,
            billNumber: input.invoiceNo!.trim(),
            billDate,
            dueDate: due,
            amount: total,
            purchaseOrderId: id,
            goodsReceiptId: grn.id,
            createdById: user.id,
          },
        });
        billId = bill.id;
      }
      return { id: grn.id, grnNumber, status, total, varianceAmount: round2(variance), billId };
    });
    this.realtime.notifyOutlet(outletId);
    return result;
  }

  async listReceipts(user: AuthUser, outletId: string): Promise<GoodsReceiptDto[]> {
    assertOutlet(user, outletId);
    const grns = await this.prisma.goodsReceipt.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { receivedAt: "desc" },
      take: 100,
      include: { purchaseOrder: { include: { vendor: true } }, lines: { include: { poLine: true } } },
    });
    return grns.map((g) => this.toReceiptDto(g, g.purchaseOrder.poNumber, g.purchaseOrder.vendor.name));
  }

  /** What each vendor actually charged per material unit, newest first. */
  async priceHistory(
    user: AuthUser,
    outletId: string,
    filter: { vendorId?: string; materialId?: string },
  ): Promise<PriceHistoryRowDto[]> {
    assertOutlet(user, outletId);
    const rows = await this.prisma.goodsReceiptLine.findMany({
      where: {
        tenantId: user.tenantId,
        receipt: { outletId, ...(filter.vendorId ? { vendorId: filter.vendorId } : {}) },
        ...(filter.materialId ? { rawMaterialId: filter.materialId } : {}),
      },
      orderBy: { receipt: { receivedAt: "desc" } },
      take: 300,
      include: { receipt: { include: { purchaseOrder: { include: { vendor: true } } } }, poLine: { include: { material: true } } },
    });
    return rows.map((r) => {
      const factor = D(r.poLine.unitFactor) || 1;
      return {
        receivedAt: r.receipt.receivedAt.toISOString(),
        vendorId: r.receipt.vendorId,
        vendorName: r.receipt.purchaseOrder.vendor.name,
        rawMaterialId: r.rawMaterialId,
        materialName: r.poLine.materialName,
        unit: r.poLine.material.unit as MaterialUnit,
        unitCost: D(r.unitCost),
        poUnitCost: round4(D(r.poRate) / factor),
        quantity: D(r.stockQty),
        grnNumber: r.receipt.grnNumber,
      };
    });
  }

  // ---------- helpers ----------

  private async resolveLines(user: AuthUser, outletId: string, input: PoLineInput[]): Promise<ResolvedLine[]> {
    const ids = [...new Set(input.map((l) => l.rawMaterialId))];
    const materials = await this.prisma.rawMaterial.findMany({
      where: { id: { in: ids }, tenantId: user.tenantId, outletId, deletedAt: null },
    });
    const byId = new Map(materials.map((m) => [m.id, m]));
    return input.map((l, i) => {
      const m = byId.get(l.rawMaterialId);
      if (!m) throw new BadRequestException("Unknown material on PO line");
      const unit = (l.unit ?? m.unit) as MaterialUnit;
      const factor = unitFactor(unit, m.unit as MaterialUnit);
      if (factor === null) throw new BadRequestException(`${m.name} is stocked in ${m.unit}; it can't be bought in ${unit}`);
      return {
        rawMaterialId: m.id,
        materialName: m.name,
        unit,
        unitFactor: factor,
        orderedQty: l.quantity,
        rate: l.rate,
        taxRate: l.taxRate ?? 0,
        sortOrder: i,
      };
    });
  }

  private totals(lines: { orderedQty: number; rate: number; taxRate: number }[]) {
    let base = 0;
    let tax = 0;
    for (const l of lines) {
      const a = lineAmountsPaise(l.orderedQty, l.rate, l.taxRate);
      base += a.basePaise;
      tax += a.taxPaise;
    }
    return { subtotal: base / 100, taxAmount: tax / 100, total: (base + tax) / 100 };
  }

  private async lockPo(tx: Prisma.TransactionClient, user: AuthUser, outletId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string; status: string; poNumber: string }[]>`
      SELECT id, status, "poNumber" FROM purchase_orders WHERE id = ${id} AND "tenantId" = ${user.tenantId}
      AND "outletId" = ${outletId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException("Purchase order not found");
    return rows[0];
  }

  private toSummary(po: {
    id: string;
    poNumber: string;
    status: string;
    vendorId: string;
    vendor: { name: string };
    expectedDate: Date | null;
    total: Prisma.Decimal;
    createdAt: Date;
    lines: { orderedQty: Prisma.Decimal; receivedQty: Prisma.Decimal }[];
  }): PurchaseOrderSummaryDto {
    const ordered = po.lines.reduce((s, l) => s + D(l.orderedQty), 0);
    const received = po.lines.reduce((s, l) => s + Math.min(D(l.receivedQty), D(l.orderedQty)), 0);
    return {
      id: po.id,
      poNumber: po.poNumber,
      status: po.status as PoStatus,
      vendorId: po.vendorId,
      vendorName: po.vendor.name,
      expectedDate: po.expectedDate ? po.expectedDate.toISOString() : null,
      total: D(po.total),
      lineCount: po.lines.length,
      receivedPct: ordered > 0 ? Math.round((received / ordered) * 100) : 0,
      createdAt: po.createdAt.toISOString(),
    };
  }

  private toReceiptDto(
    g: {
      id: string;
      grnNumber: string;
      purchaseOrderId: string;
      invoiceNo: string | null;
      note: string | null;
      subtotal: Prisma.Decimal;
      taxAmount: Prisma.Decimal;
      total: Prisma.Decimal;
      varianceAmount: Prisma.Decimal;
      receivedAt: Date;
      lines: {
        id: string;
        purchaseOrderLineId: string;
        quantity: Prisma.Decimal;
        rate: Prisma.Decimal;
        poRate: Prisma.Decimal;
        taxRate: Prisma.Decimal;
        lineTotal: Prisma.Decimal;
        priceVariance: Prisma.Decimal;
        poLine: { materialName: string; unit: string };
      }[];
    },
    poNumber: string,
    vendorName: string,
  ): GoodsReceiptDto {
    return {
      id: g.id,
      grnNumber: g.grnNumber,
      purchaseOrderId: g.purchaseOrderId,
      poNumber,
      vendorName,
      invoiceNo: g.invoiceNo,
      note: g.note,
      subtotal: D(g.subtotal),
      taxAmount: D(g.taxAmount),
      total: D(g.total),
      varianceAmount: D(g.varianceAmount),
      receivedAt: g.receivedAt.toISOString(),
      lines: g.lines.map((l) => ({
        id: l.id,
        poLineId: l.purchaseOrderLineId,
        materialName: l.poLine.materialName,
        unit: l.poLine.unit as MaterialUnit,
        quantity: D(l.quantity),
        rate: D(l.rate),
        poRate: D(l.poRate),
        taxRate: D(l.taxRate),
        lineTotal: D(l.lineTotal),
        priceVariance: D(l.priceVariance),
        priceVariancePct: priceVariance(D(l.poRate), D(l.rate), 1).pct,
      })),
    };
  }
}
