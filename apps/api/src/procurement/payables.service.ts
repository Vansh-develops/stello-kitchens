import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  SupplierBillDto,
  SupplierBillInput,
  SupplierPaymentDto,
  SupplierPaymentInput,
  VendorPayableDto,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { D, assertOutlet, parseDay, round2 } from "./procurement.common";

const toPaise = (n: number) => Math.round(n * 100);

function billStatus(amountPaise: number, paidPaise: number): "OPEN" | "PARTIAL" | "PAID" {
  if (paidPaise >= amountPaise) return "PAID";
  return paidPaise > 0 ? "PARTIAL" : "OPEN";
}

@Injectable()
export class PayablesService {
  constructor(private readonly prisma: PrismaService) {}

  async listBills(
    user: AuthUser,
    outletId: string,
    filter: { vendorId?: string; status?: string },
  ): Promise<SupplierBillDto[]> {
    assertOutlet(user, outletId);
    const bills = await this.prisma.supplierBill.findMany({
      where: {
        tenantId: user.tenantId,
        outletId,
        ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
        ...(filter.status === "UNPAID"
          ? { status: { in: ["OPEN", "PARTIAL"] } }
          : filter.status
            ? { status: filter.status }
            : {}),
      },
      orderBy: [{ billDate: "desc" }, { createdAt: "desc" }],
      take: 300,
      include: { vendor: true },
    });
    const poIds = [...new Set(bills.map((b) => b.purchaseOrderId).filter((x): x is string => !!x))];
    const grnIds = [...new Set(bills.map((b) => b.goodsReceiptId).filter((x): x is string => !!x))];
    const [pos, grns] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { id: { in: poIds }, tenantId: user.tenantId }, select: { id: true, poNumber: true } }),
      this.prisma.goodsReceipt.findMany({ where: { id: { in: grnIds }, tenantId: user.tenantId }, select: { id: true, grnNumber: true } }),
    ]);
    const poNo = new Map(pos.map((p) => [p.id, p.poNumber]));
    const grnNo = new Map(grns.map((g) => [g.id, g.grnNumber]));
    const today = new Date();
    return bills.map((b) => {
      const outstanding = round2(D(b.amount) - D(b.paidAmount));
      return {
        id: b.id,
        vendorId: b.vendorId,
        vendorName: b.vendor.name,
        billNumber: b.billNumber,
        billDate: b.billDate.toISOString(),
        dueDate: b.dueDate?.toISOString() ?? null,
        amount: D(b.amount),
        paidAmount: D(b.paidAmount),
        outstanding: b.status === "VOID" ? 0 : outstanding,
        status: b.status as SupplierBillDto["status"],
        overdue: b.status !== "VOID" && outstanding > 0 && !!b.dueDate && b.dueDate < today,
        poNumber: b.purchaseOrderId ? poNo.get(b.purchaseOrderId) ?? null : null,
        grnNumber: b.goodsReceiptId ? grnNo.get(b.goodsReceiptId) ?? null : null,
      };
    });
  }

  async createBill(user: AuthUser, outletId: string, input: SupplierBillInput) {
    assertOutlet(user, outletId);
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: input.vendorId, tenantId: user.tenantId, outletId, deletedAt: null },
    });
    if (!vendor) throw new BadRequestException("Vendor not found in this outlet");
    if (input.purchaseOrderId) {
      const po = await this.prisma.purchaseOrder.findFirst({
        where: { id: input.purchaseOrderId, tenantId: user.tenantId, outletId, vendorId: input.vendorId },
      });
      if (!po) throw new BadRequestException("PO not found for this vendor");
    }
    if (input.goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findFirst({
        where: { id: input.goodsReceiptId, tenantId: user.tenantId, outletId, vendorId: input.vendorId },
      });
      if (!grn) throw new BadRequestException("Goods receipt not found for this vendor");
      if (await this.prisma.supplierBill.findFirst({ where: { goodsReceiptId: grn.id, tenantId: user.tenantId } })) {
        throw new BadRequestException("That goods receipt already has a bill");
      }
    }
    if (await this.prisma.supplierBill.findFirst({ where: { vendorId: input.vendorId, billNumber: input.billNumber, tenantId: user.tenantId } })) {
      throw new BadRequestException(`Bill ${input.billNumber} is already booked for this vendor`);
    }
    const billDate = parseDay(input.billDate);
    const bill = await this.prisma.supplierBill.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        vendorId: input.vendorId,
        billNumber: input.billNumber,
        billDate,
        dueDate: input.dueDate
          ? parseDay(input.dueDate)
          : vendor.paymentTermsDays != null
            ? new Date(billDate.getTime() + vendor.paymentTermsDays * 86400000)
            : null,
        amount: input.amount,
        purchaseOrderId: input.purchaseOrderId ?? null,
        goodsReceiptId: input.goodsReceiptId ?? null,
        note: input.note ?? null,
        createdById: user.id,
      },
    });
    return { id: bill.id };
  }

  async voidBill(user: AuthUser, outletId: string, id: string) {
    assertOutlet(user, outletId);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string; paidAmount: Prisma.Decimal }[]>`
        SELECT id, status, "paidAmount" FROM supplier_bills WHERE id = ${id} AND "tenantId" = ${user.tenantId}
        AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Bill not found");
      if (rows[0].status === "VOID") throw new BadRequestException("Bill is already void");
      if (D(rows[0].paidAmount) > 0) throw new BadRequestException("A bill with payments can't be voided");
      await tx.supplierBill.update({ where: { id }, data: { status: "VOID" } });
      return { id, status: "VOID" };
    });
  }

  async listPayments(user: AuthUser, outletId: string, vendorId?: string): Promise<SupplierPaymentDto[]> {
    assertOutlet(user, outletId);
    const payments = await this.prisma.supplierPayment.findMany({
      where: { tenantId: user.tenantId, outletId, ...(vendorId ? { vendorId } : {}) },
      orderBy: { paidAt: "desc" },
      take: 200,
      include: { vendor: true, allocations: { include: { bill: true } } },
    });
    return payments.map((p) => ({
      id: p.id,
      vendorId: p.vendorId,
      vendorName: p.vendor.name,
      amount: D(p.amount),
      unallocated: D(p.unallocated),
      mode: p.mode,
      reference: p.reference,
      paidAt: p.paidAt.toISOString(),
      allocations: p.allocations.map((a) => ({ billId: a.billId, billNumber: a.bill.billNumber, amount: D(a.amount) })),
    }));
  }

  /**
   * Record a payment. Explicit allocations are validated against each bill's
   * outstanding; otherwise the oldest open bills are settled first. Any
   * remainder stays on the payment as vendor credit. The vendor's open bills
   * are row-locked so two payments can't over-settle the same bill.
   */
  async recordPayment(user: AuthUser, outletId: string, input: SupplierPaymentInput) {
    assertOutlet(user, outletId);
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: input.vendorId, tenantId: user.tenantId, outletId, deletedAt: null },
    });
    if (!vendor) throw new BadRequestException("Vendor not found in this outlet");

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM supplier_bills WHERE "vendorId" = ${input.vendorId} AND "tenantId" = ${user.tenantId}
        AND "outletId" = ${outletId} AND status IN ('OPEN', 'PARTIAL') ORDER BY id FOR UPDATE`;
      const open = await tx.supplierBill.findMany({
        where: { vendorId: input.vendorId, tenantId: user.tenantId, outletId, status: { in: ["OPEN", "PARTIAL"] } },
        orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { billDate: "asc" }, { createdAt: "asc" }],
      });
      const outstanding = new Map(open.map((b) => [b.id, toPaise(D(b.amount)) - toPaise(D(b.paidAmount))]));
      const amountPaise = toPaise(input.amount);

      let plan: { billId: string; paise: number }[];
      if (input.allocations?.length) {
        plan = input.allocations.map((a) => {
          const due = outstanding.get(a.billId);
          if (due === undefined) throw new BadRequestException("Allocation to a bill that isn't open for this vendor");
          const paise = toPaise(a.amount);
          if (paise > due) throw new BadRequestException("Allocation exceeds the bill's outstanding amount");
          return { billId: a.billId, paise };
        });
        if (new Set(plan.map((p) => p.billId)).size !== plan.length) throw new BadRequestException("Duplicate bill allocation");
        if (plan.reduce((s, p) => s + p.paise, 0) > amountPaise) {
          throw new BadRequestException("Allocations exceed the payment amount");
        }
      } else {
        plan = [];
        let left = amountPaise;
        for (const b of open) {
          if (left <= 0) break;
          const paise = Math.min(left, outstanding.get(b.id)!);
          if (paise > 0) plan.push({ billId: b.id, paise });
          left -= paise;
        }
      }
      const allocated = plan.reduce((s, p) => s + p.paise, 0);

      const payment = await tx.supplierPayment.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          vendorId: input.vendorId,
          amount: input.amount,
          unallocated: (amountPaise - allocated) / 100,
          mode: input.mode,
          reference: input.reference ?? null,
          note: input.note ?? null,
          paidAt: input.paidAt ? parseDay(input.paidAt) : new Date(),
          createdById: user.id,
        },
      });
      for (const p of plan) {
        const bill = open.find((b) => b.id === p.billId)!;
        const paidPaise = toPaise(D(bill.paidAmount)) + p.paise;
        await tx.supplierPaymentAllocation.create({
          data: { tenantId: user.tenantId, paymentId: payment.id, billId: p.billId, amount: p.paise / 100 },
        });
        await tx.supplierBill.update({
          where: { id: p.billId },
          data: { paidAmount: paidPaise / 100, status: billStatus(toPaise(D(bill.amount)), paidPaise) },
        });
      }
      return { id: payment.id, allocated: allocated / 100, unallocated: (amountPaise - allocated) / 100 };
    });
  }

  /** Outstanding by vendor. */
  async payables(user: AuthUser, outletId: string): Promise<VendorPayableDto[]> {
    assertOutlet(user, outletId);
    const [vendors, bills, payments] = await Promise.all([
      this.prisma.vendor.findMany({ where: { tenantId: user.tenantId, outletId, deletedAt: null } }),
      this.prisma.supplierBill.findMany({ where: { tenantId: user.tenantId, outletId, status: { not: "VOID" } } }),
      this.prisma.supplierPayment.findMany({ where: { tenantId: user.tenantId, outletId } }),
    ]);
    const today = new Date();
    const rows: VendorPayableDto[] = vendors.map((v) => {
      const vb = bills.filter((b) => b.vendorId === v.id);
      const vp = payments.filter((p) => p.vendorId === v.id);
      const billed = vb.reduce((s, b) => s + toPaise(D(b.amount)), 0);
      const paidOnBills = vb.reduce((s, b) => s + toPaise(D(b.paidAmount)), 0);
      const open = vb.filter((b) => b.status === "OPEN" || b.status === "PARTIAL");
      const overdue = open
        .filter((b) => b.dueDate && b.dueDate < today)
        .reduce((s, b) => s + toPaise(D(b.amount)) - toPaise(D(b.paidAmount)), 0);
      const dues = open.map((b) => b.dueDate).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
      return {
        vendorId: v.id,
        vendorName: v.name,
        billed: billed / 100,
        paid: vp.reduce((s, p) => s + toPaise(D(p.amount)), 0) / 100,
        outstanding: (billed - paidOnBills) / 100,
        overdue: overdue / 100,
        credit: vp.reduce((s, p) => s + toPaise(D(p.unallocated)), 0) / 100,
        openBills: open.length,
        oldestDue: dues[0]?.toISOString() ?? null,
      };
    });
    return rows
      .filter((r) => r.billed > 0 || r.paid > 0)
      .sort((a, b) => b.outstanding - a.outstanding);
  }
}
