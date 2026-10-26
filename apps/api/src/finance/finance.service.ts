import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  DayBookDto,
  DayBookEntryDto,
  ExpenseCategoryDto,
  ExpenseCategoryInput,
  ExpenseDto,
  ExpenseInput,
  ExpensePaidFrom,
  PnlDto,
  PnlFigures,
} from "@stello/shared";
import {
  buildPnl,
  comparePeriod,
  daysBetween,
  daysInMonth,
  expenseCost,
  fromPaise,
  istDateOf,
  istRange,
  toPaise,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const N = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : typeof d === "number" ? d : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Record a POS cash-drawer expense in the expense book, inside the caller's
 * transaction. The category is matched (or created) by name so drawer expenses
 * and back-office expenses share one chart of categories.
 */
export async function recordDrawerExpenseTx(
  tx: Prisma.TransactionClient,
  p: { tenantId: string; outletId: string; userId: string | null; cashMovementId: string; category: string; amount: number; note: string | null },
): Promise<void> {
  const name = p.category.trim() || "General";
  const category = await tx.expenseCategory.upsert({
    where: { tenantId_name: { tenantId: p.tenantId, name } },
    create: { tenantId: p.tenantId, name },
    update: {},
  });
  await tx.expense.create({
    data: {
      tenantId: p.tenantId,
      outletId: p.outletId,
      categoryId: category.id,
      date: asDate(istDateOf(new Date())),
      taxableAmount: p.amount,
      total: p.amount,
      itcEligible: false,
      paidFrom: "CASH_DRAWER",
      note: p.note,
      cashMovementId: p.cashMovementId,
      createdById: p.userId,
    },
  });
}

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: { category: true } }>;

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  private checkRange(from: string, to: string) {
    if (to < from) throw new BadRequestException("'to' must be on/after 'from'");
    if (daysBetween(from, to) > 400) throw new BadRequestException("Range is limited to 400 days");
  }

  // ---------- Categories ----------

  async categories(user: AuthUser): Promise<ExpenseCategoryDto[]> {
    const rows = await this.prisma.expenseCategory.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: "asc" } });
    return rows.map((c) => ({ id: c.id, name: c.name, ledgerName: c.ledgerName, isActive: c.isActive }));
  }

  async createCategory(user: AuthUser, input: ExpenseCategoryInput): Promise<ExpenseCategoryDto> {
    const name = input.name.trim();
    const dup = await this.prisma.expenseCategory.findFirst({ where: { tenantId: user.tenantId, name } });
    if (dup) throw new BadRequestException("A category with this name already exists");
    const c = await this.prisma.expenseCategory.create({
      data: { tenantId: user.tenantId, name, ledgerName: input.ledgerName ?? null, isActive: input.isActive },
    });
    return { id: c.id, name: c.name, ledgerName: c.ledgerName, isActive: c.isActive };
  }

  async updateCategory(user: AuthUser, id: string, input: Partial<ExpenseCategoryInput>): Promise<ExpenseCategoryDto> {
    const existing = await this.prisma.expenseCategory.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) throw new NotFoundException("Category not found");
    const c = await this.prisma.expenseCategory.update({
      where: { id },
      data: { name: input.name?.trim(), ledgerName: input.ledgerName, isActive: input.isActive },
    });
    return { id: c.id, name: c.name, ledgerName: c.ledgerName, isActive: c.isActive };
  }

  // ---------- Expenses ----------

  async listExpenses(user: AuthUser, outletId: string, from: string, to: string): Promise<ExpenseDto[]> {
    this.assertOutlet(user, outletId);
    this.checkRange(from, to);
    const rows = await this.prisma.expense.findMany({
      where: { tenantId: user.tenantId, outletId, date: { gte: asDate(from), lte: asDate(to) } },
      include: { category: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    return rows.map((e) => this.toExpenseDto(e));
  }

  async createExpense(user: AuthUser, outletId: string, input: ExpenseInput): Promise<ExpenseDto> {
    this.assertOutlet(user, outletId);
    const category = await this.prisma.expenseCategory.findFirst({ where: { id: input.categoryId, tenantId: user.tenantId } });
    if (!category) throw new BadRequestException("Unknown expense category");
    const totalPaise = toPaise(input.taxableAmount) + toPaise(input.cgst) + toPaise(input.sgst) + toPaise(input.igst);
    const total = fromPaise(totalPaise);
    const id = await this.prisma.$transaction(async (tx) => {
      let cashMovementId: string | null = null;
      if (input.paidFrom === "CASH_DRAWER") {
        // Lock the open session so a concurrent close cannot miss this payout.
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM cash_sessions WHERE "tenantId" = ${user.tenantId} AND "outletId" = ${outletId}
          AND status = 'OPEN' FOR UPDATE`;
        if (!rows.length) throw new BadRequestException("Open the cash drawer to pay an expense from it");
        const m = await tx.cashMovement.create({
          data: { sessionId: rows[0].id, type: "EXPENSE", amount: -total, category: category.name, note: input.note ?? input.vendorName ?? null },
        });
        cashMovementId = m.id;
      }
      const e = await tx.expense.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          categoryId: category.id,
          date: asDate(input.date),
          taxableAmount: input.taxableAmount,
          cgst: input.cgst,
          sgst: input.sgst,
          igst: input.igst,
          total,
          itcEligible: input.itcEligible,
          vendorName: input.vendorName ?? null,
          vendorGstin: input.vendorGstin ?? null,
          invoiceNumber: input.invoiceNumber ?? null,
          paidFrom: input.paidFrom,
          reference: input.reference ?? null,
          note: input.note ?? null,
          attachmentUrl: input.attachmentUrl ?? null,
          cashMovementId,
          createdById: user.id,
        },
      });
      return e.id;
    });
    const row = await this.prisma.expense.findFirstOrThrow({ where: { id, tenantId: user.tenantId }, include: { category: true } });
    return this.toExpenseDto(row);
  }

  async voidExpense(user: AuthUser, outletId: string, id: string, reason: string): Promise<ExpenseDto> {
    this.assertOutlet(user, outletId);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; voidedAt: Date | null; cashMovementId: string | null; total: Prisma.Decimal }[]>`
        SELECT id, "voidedAt", "cashMovementId", total FROM expenses
        WHERE id = ${id} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      const e = rows[0];
      if (!e) throw new NotFoundException("Expense not found");
      if (e.voidedAt) throw new BadRequestException("Expense is already void");
      // If the cash went out of a still-open drawer, put it back on the books.
      if (e.cashMovementId) {
        const m = await tx.cashMovement.findUnique({ where: { id: e.cashMovementId }, include: { session: true } });
        if (m && m.session.status === "OPEN") {
          await tx.cashMovement.create({
            data: { sessionId: m.sessionId, type: "PAY_IN", amount: N(e.total), category: "EXPENSE_VOID", note: `Void: ${reason}` },
          });
        }
      }
      await tx.expense.update({ where: { id }, data: { voidedAt: new Date(), voidReason: reason } });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "EXPENSE_VOIDED", entity: "expense", entityId: id, data: { reason } },
      });
    });
    const row = await this.prisma.expense.findFirstOrThrow({ where: { id, tenantId: user.tenantId }, include: { category: true } });
    return this.toExpenseDto(row);
  }

  // ---------- P&L ----------

  async pnl(user: AuthUser, outletId: string, from: string, to: string, compare: "prev" | "yoy" | "none"): Promise<PnlDto> {
    this.assertOutlet(user, outletId);
    this.checkRange(from, to);
    const current = await this.figures(user.tenantId, outletId, from, to);
    let cmp: PnlDto["compare"] = null;
    if (compare !== "none") {
      const range = comparePeriod(from, to, compare);
      cmp = { ...(await this.figures(user.tenantId, outletId, range.from, range.to)), ...range };
    }
    return { outletId, from, to, current, compare: cmp };
  }

  /** Raw P&L aggregates for one outlet and inclusive IST date range. */
  async figures(tenantId: string, outletId: string, from: string, to: string): Promise<PnlFigures> {
    const range = istRange(from, to);
    const [sales, refunds, movements, expenses, runs] = await Promise.all([
      this.prisma.order.aggregate({
        where: { tenantId, outletId, status: "SETTLED", createdAt: range },
        _sum: { subtotal: true, discountAmount: true, taxAmount: true },
        _count: true,
      }),
      this.prisma.refund.findMany({ where: { tenantId, outletId, status: { not: "FAILED" }, createdAt: range } }),
      this.prisma.stockMovement.findMany({
        where: { tenantId, outletId, type: { in: ["CONSUMPTION", "WASTAGE"] }, createdAt: range },
        include: { material: { select: { costPerUnit: true } } },
      }),
      this.prisma.expense.findMany({
        where: { tenantId, outletId, voidedAt: null, date: { gte: asDate(from), lte: asDate(to) } },
        include: { category: true },
      }),
      this.prisma.payrollRun.findMany({
        where: { tenantId, outletId, status: "FINALISED", month: { gte: from.slice(0, 7), lte: to.slice(0, 7) } },
        include: { payslips: { select: { employerCost: true } } },
      }),
    ]);

    // Refunds reduce revenue net of their tax share.
    let refundsNet = 0;
    if (refunds.length) {
      const orders = await this.prisma.order.findMany({
        where: { tenantId, id: { in: [...new Set(refunds.map((r) => r.orderId))] } },
        select: { id: true, total: true, taxAmount: true },
      });
      const byId = new Map(orders.map((o) => [o.id, o]));
      for (const r of refunds) {
        const o = byId.get(r.orderId);
        const total = N(o?.total);
        refundsNet += total > 0 ? N(r.amount) * (1 - N(o?.taxAmount) / total) : N(r.amount);
      }
    }

    let cogs = 0;
    let wastage = 0;
    for (const m of movements) {
      const cost = Math.abs(N(m.quantity)) * (m.unitCost != null ? N(m.unitCost) : N(m.material.costPerUnit));
      if (m.type === "CONSUMPTION") cogs += cost;
      else wastage += cost;
    }

    // A month's payroll is spread evenly over its days; count the overlap.
    let payroll = 0;
    for (const run of runs) {
      const dim = daysInMonth(run.month);
      const mStart = `${run.month}-01`;
      const mEnd = `${run.month}-${String(dim).padStart(2, "0")}`;
      const s = from > mStart ? from : mStart;
      const e = to < mEnd ? to : mEnd;
      const overlap = daysBetween(s, e) + 1;
      if (overlap <= 0) continue;
      const cost = run.payslips.reduce((sum, p) => sum + N(p.employerCost), 0);
      payroll += (cost * overlap) / dim;
    }

    return buildPnl({
      grossSales: N(sales._sum.subtotal),
      discounts: N(sales._sum.discountAmount),
      refunds: r2(refundsNet),
      taxCollected: N(sales._sum.taxAmount),
      cogs: r2(cogs),
      wastage: r2(wastage),
      expenses: expenses.map((e) => ({
        category: e.category.name,
        amount: expenseCost({ taxableAmount: N(e.taxableAmount), cgst: N(e.cgst), sgst: N(e.sgst), igst: N(e.igst), itcEligible: e.itcEligible }),
      })),
      payroll: r2(payroll),
      orders: sales._count,
    });
  }

  // ---------- Day book ----------

  async dayBook(user: AuthUser, outletId: string, from: string, to: string): Promise<DayBookDto> {
    this.assertOutlet(user, outletId);
    this.checkRange(from, to);
    if (daysBetween(from, to) > 92) throw new BadRequestException("Day book range is limited to 93 days");
    const tenantId = user.tenantId;
    const range = istRange(from, to);
    const [orders, refunds, expenses, cash, advances, giftSales, runs] = await Promise.all([
      this.prisma.orderPayment.findMany({
        where: { createdAt: range, order: { tenantId, outletId, status: "SETTLED" } },
        include: { order: { select: { billNumber: true } } },
      }),
      this.prisma.refund.findMany({ where: { tenantId, outletId, status: { not: "FAILED" }, createdAt: range } }),
      this.prisma.expense.findMany({
        where: { tenantId, outletId, voidedAt: null, date: { gte: asDate(from), lte: asDate(to) } },
        include: { category: true },
      }),
      this.prisma.cashMovement.findMany({
        where: { type: { in: ["PAY_IN", "PAY_OUT"] }, createdAt: range, session: { tenantId, outletId } },
      }),
      this.prisma.salaryAdvance.findMany({ where: { tenantId, outletId, givenOn: { gte: asDate(from), lte: asDate(to) } } }),
      this.prisma.giftCardTxn.findMany({
        where: { tenantId, outletId, type: "ISSUE", createdAt: range, paymentMode: { not: "COMPLIMENTARY" } },
        include: { giftCard: { select: { code: true } } },
      }),
      this.prisma.payrollRun.findMany({
        where: { tenantId, outletId, status: "FINALISED", finalisedAt: range },
        include: { payslips: { select: { net: true } } },
      }),
    ]);
    const entries: DayBookEntryDto[] = [];
    for (const p of orders) {
      const bill = p.order.billNumber;
      entries.push({ at: p.createdAt.toISOString(), kind: "SALE", ref: bill, description: `Bill ${bill ?? ""}`.trim(), mode: p.mode, inflow: N(p.amount), outflow: 0 });
    }
    for (const r of refunds) {
      entries.push({
        at: r.createdAt.toISOString(),
        kind: "REFUND",
        ref: r.gatewayRef,
        description: r.reason ?? "Refund",
        mode: r.mode === "GIFT_CARD" ? "STORE_CREDIT" : r.mode,
        inflow: 0,
        outflow: N(r.amount),
      });
    }
    for (const e of expenses) {
      entries.push({
        at: e.createdAt.toISOString(),
        kind: "EXPENSE",
        ref: e.invoiceNumber,
        description: [e.category.name, e.vendorName, e.note].filter(Boolean).join(" · "),
        mode: e.paidFrom === "CASH_DRAWER" ? "CASH" : e.paidFrom,
        inflow: 0,
        outflow: N(e.total),
      });
    }
    for (const m of cash) {
      // Gift card cash and expense voids are reported by their own entries.
      if (m.category === "GIFT_CARD_SALE" || m.category === "SALARY_ADVANCE") continue;
      const amt = N(m.amount);
      entries.push({
        at: m.createdAt.toISOString(),
        kind: amt >= 0 ? "CASH_IN" : "CASH_OUT",
        ref: null,
        description: m.note ?? (amt >= 0 ? "Cash pay-in" : "Cash pay-out"),
        mode: "CASH",
        inflow: amt >= 0 ? amt : 0,
        outflow: amt < 0 ? -amt : 0,
      });
    }
    for (const a of advances) {
      entries.push({
        at: a.createdAt.toISOString(),
        kind: "ADVANCE",
        ref: null,
        description: `Salary advance${a.note ? ` · ${a.note}` : ""}`,
        mode: a.paidFrom === "CASH_DRAWER" ? "CASH" : "BANK",
        inflow: 0,
        outflow: N(a.amount),
      });
    }
    for (const g of giftSales) {
      entries.push({ at: g.createdAt.toISOString(), kind: "GIFT_CARD_SALE", ref: g.giftCard.code, description: "Gift card sold", mode: g.paymentMode ?? "OTHER", inflow: N(g.amount), outflow: 0 });
    }
    for (const run of runs) {
      entries.push({
        at: run.finalisedAt!.toISOString(),
        kind: "PAYROLL",
        ref: run.month,
        description: `Payroll ${run.month} (${run.payslips.length} staff)`,
        mode: "BANK",
        inflow: 0,
        outflow: r2(run.payslips.reduce((s, p) => s + N(p.net), 0)),
      });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));
    const modes = new Map<string, { inflow: number; outflow: number }>();
    for (const e of entries) {
      const m = modes.get(e.mode) ?? { inflow: 0, outflow: 0 };
      m.inflow += toPaise(e.inflow);
      m.outflow += toPaise(e.outflow);
      modes.set(e.mode, m);
    }
    const byMode = [...modes.entries()].map(([mode, v]) => ({
      mode,
      inflow: fromPaise(v.inflow),
      outflow: fromPaise(v.outflow),
      net: fromPaise(v.inflow - v.outflow),
    }));
    const tin = [...modes.values()].reduce((s, v) => s + v.inflow, 0);
    const tout = [...modes.values()].reduce((s, v) => s + v.outflow, 0);
    return { from, to, entries, byMode, totals: { inflow: fromPaise(tin), outflow: fromPaise(tout), net: fromPaise(tin - tout) } };
  }

  // ---------- Tally ----------

  /** Tally-importable Payment/Journal vouchers for expenses (Dr expense + input GST, Cr cash/bank/creditor). */
  async tallyExpenses(user: AuthUser, outletId: string, from: string, to: string): Promise<string> {
    this.assertOutlet(user, outletId);
    this.checkRange(from, to);
    const rows = await this.prisma.expense.findMany({
      where: { tenantId: user.tenantId, outletId, voidedAt: null, date: { gte: asDate(from), lte: asDate(to) } },
      include: { category: true },
      orderBy: { date: "asc" },
    });
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const amt = (n: number) => n.toFixed(2);
    const credit: Record<string, string> = { CASH_DRAWER: "Cash", BANK: "Bank", UPI: "Bank", CARD: "Bank" };
    // Tally convention: debits are ISDEEMEDPOSITIVE=Yes with a negative amount.
    const dr = (ledger: string, n: number) =>
      `     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(n)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    const cr = (ledger: string, n: number) =>
      `     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(n)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    const vouchers = rows
      .map((e) => {
        const ledger = e.category.ledgerName || e.category.name;
        const party = e.paidFrom === "PAYABLE" ? e.vendorName || "Sundry Creditors" : credit[e.paidFrom] ?? "Cash";
        const type = e.paidFrom === "PAYABLE" ? "Journal" : "Payment";
        const lines: string[] = [];
        if (e.itcEligible) {
          lines.push(dr(ledger, N(e.taxableAmount)));
          if (N(e.cgst) > 0) lines.push(dr("Input CGST", N(e.cgst)));
          if (N(e.sgst) > 0) lines.push(dr("Input SGST", N(e.sgst)));
          if (N(e.igst) > 0) lines.push(dr("Input IGST", N(e.igst)));
        } else {
          lines.push(dr(ledger, N(e.total)));
        }
        lines.push(cr(party, N(e.total)));
        const narration = [e.vendorName, e.invoiceNumber && `Inv ${e.invoiceNumber}`, e.note].filter(Boolean).join(" · ");
        return `   <TALLYMESSAGE>
    <VOUCHER VCHTYPE="${type}" ACTION="Create">
     <DATE>${dateStr(e.date).replace(/-/g, "")}</DATE>
     <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>
     <NARRATION>${esc(narration)}</NARRATION>
${lines.join("\n")}
    </VOUCHER>
   </TALLYMESSAGE>`;
      })
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
   <REQUESTDATA>
${vouchers}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
  }

  private toExpenseDto(e: ExpenseRow): ExpenseDto {
    return {
      id: e.id,
      categoryId: e.categoryId,
      categoryName: e.category.name,
      date: dateStr(e.date),
      taxableAmount: N(e.taxableAmount),
      cgst: N(e.cgst),
      sgst: N(e.sgst),
      igst: N(e.igst),
      total: N(e.total),
      itcEligible: e.itcEligible,
      vendorName: e.vendorName,
      vendorGstin: e.vendorGstin,
      invoiceNumber: e.invoiceNumber,
      paidFrom: e.paidFrom as ExpensePaidFrom,
      reference: e.reference,
      note: e.note,
      attachmentUrl: e.attachmentUrl,
      fromDrawer: !!e.cashMovementId,
      voidedAt: e.voidedAt?.toISOString() ?? null,
      voidReason: e.voidReason,
      createdAt: e.createdAt.toISOString(),
    };
  }
}

