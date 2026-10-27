import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthUser, CreateOrderInput } from "@stello/shared";
import { istAt } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { CashService } from "../src/payments/cash.service";
import { GiftCardsService } from "../src/gift-cards/gift-cards.service";
import { FinanceService } from "../src/finance/finance.service";
import { StaffService } from "../src/staff/staff.service";
import { RosterService } from "../src/staff/roster.service";
import { PayrollService } from "../src/staff/payroll.service";
import { testPrisma } from "./db";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());
const realtime = { notifyOutlet: vi.fn() };
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const gateway = { name: "test", createUpiQr: vi.fn(), refund: vi.fn(async () => ({ ref: "x", status: "processed" })) };
const cash = new CashService(prisma, gateway as any);
const gifts = new GiftCardsService(prisma);
const finance = new FinanceService(prisma);
const staffSvc = new StaffService(prisma);
const roster = new RosterService(prisma);
const payroll = new PayrollService(prisma);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function fixture(name = "HR") {
  const tenant = await prisma.tenant.create({ data: { name } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({ data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "x" } });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet" } });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
  const item = await prisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Meal", price: 100, taxRate: 5 } });
  const user: AuthUser = { id: actor.id, tenantId: tenant.id, email: actor.email, name: "Owner", roleName: "Owner", permissions: ["*"], outletIds: [outlet.id], isPlatformAdmin: false };
  const input: CreateOrderInput = { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: item.id, quantity: 1, addonIds: [] }], combos: [] };
  return { tenant, outlet, item, user, input };
}

// Hold a row lock so all callers queue on it, then release together.
async function contend<T>(lock: (tx: any) => Promise<unknown>, jobs: (() => Promise<T>)[]) {
  let unlock!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((r) => (ready = r));
  const release = new Promise<void>((r) => (unlock = r));
  const blocker = testPrisma.$transaction(async (tx) => { await lock(tx); ready(); await release; });
  await held;
  const pending = Promise.allSettled(jobs.map((j) => j()));
  await new Promise((r) => setTimeout(r, 200));
  unlock();
  await blocker;
  return pending;
}

describe("gift cards", () => {
  it("never overspends a card under concurrent redemptions", async () => {
    const f = await fixture();
    const card = await gifts.issue(f.user, f.outlet.id, { amount: 250, paymentMode: "CASH" });
    const open = [];
    for (let i = 0; i < 4; i++) open.push(await orders.create(f.user, f.input));
    const code = card.code.replace(/-/g, "");
    const results = await contend((tx) => tx.$queryRaw`SELECT id FROM gift_cards WHERE code = ${code} FOR UPDATE`,
      open.map((o) => () => orders.settle(f.user, o.id, { payments: [{ mode: "GIFT_CARD", amount: 105, giftCardCode: card.code }] })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    // Only two ₹105 redemptions fit in ₹250. Losers fail on balance (or, on a slow
    // machine, time out waiting for the card lock) — never by overspending.
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(2);
    for (const r of results) if (r.status === "rejected") expect(r.reason.message).toMatch(/balance is ₹(40|145)\.00|Transaction/);
    const after = await prisma.giftCard.findFirstOrThrow({ where: { id: card.id } });
    expect(Number(after.balance)).toBe(250 - 105 * ok);
    const ledger = await prisma.giftCardTxn.findMany({ where: { giftCardId: card.id } });
    expect(ledger.reduce((s, t) => s + Number(t.amount), 0)).toBe(250 - 105 * ok);
    expect(ledger.filter((t) => t.type === "REDEEM")).toHaveLength(ok);
    expect(await prisma.orderPayment.count({ where: { mode: "GIFT_CARD" } })).toBe(ok);
    expect(await prisma.order.count({ where: { status: "SETTLED" } })).toBe(ok);
  });

  it("supports split tender and rolls back the card when settlement fails", async () => {
    const f = await fixture();
    const card = await gifts.issue(f.user, f.outlet.id, { amount: 100, paymentMode: "UPI" });
    const order = await orders.create(f.user, f.input);
    // Underpaid overall → whole settlement rolls back, card untouched.
    await expect(orders.settle(f.user, order.id, { payments: [{ mode: "GIFT_CARD", amount: 60, giftCardCode: card.code }] })).rejects.toThrow("must equal");
    expect((await gifts.balance(f.user, f.outlet.id, card.code)).balance).toBe(100);
    const paid = await orders.settle(f.user, order.id, {
      payments: [{ mode: "GIFT_CARD", amount: 60, giftCardCode: card.code.toLowerCase() }, { mode: "CASH", amount: 45 }],
    });
    expect(paid.status).toBe("SETTLED");
    expect((await gifts.balance(f.user, f.outlet.id, card.code)).balance).toBe(40);
  });

  it("rejects void and expired cards", async () => {
    const f = await fixture();
    const voided = await gifts.issue(f.user, f.outlet.id, { amount: 500, paymentMode: "CASH" });
    await gifts.void(f.user, voided.id, "Lost card");
    const o1 = await orders.create(f.user, f.input);
    await expect(orders.settle(f.user, o1.id, { payments: [{ mode: "GIFT_CARD", amount: 105, giftCardCode: voided.code }] })).rejects.toThrow("is void");
    const exp = await gifts.issue(f.user, f.outlet.id, { amount: 500, paymentMode: "CASH" });
    await prisma.giftCard.update({ where: { id: exp.id }, data: { expiresOn: d("2020-01-01") } });
    await expect(orders.settle(f.user, o1.id, { payments: [{ mode: "GIFT_CARD", amount: 105, giftCardCode: exp.code }] })).rejects.toThrow("expired");
    expect((await gifts.balance(f.user, f.outlet.id, exp.code)).usable).toBe(false);
  });

  it("isolates cards between tenants", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    const card = await gifts.issue(a.user, a.outlet.id, { amount: 500, paymentMode: "CASH" });
    const order = await orders.create(b.user, b.input);
    await expect(orders.settle(b.user, order.id, { payments: [{ mode: "GIFT_CARD", amount: 105, giftCardCode: card.code }] })).rejects.toThrow("not found");
    expect((await gifts.balance(b.user, b.outlet.id, card.code)).reason).toBe("Card not found");
    expect(await gifts.list(b.user)).toHaveLength(0);
    await expect(gifts.detail(b.user, card.id)).rejects.toThrow("not found");
    await expect(gifts.void(b.user, card.id, "steal")).rejects.toThrow("not found");
    expect((await gifts.balance(a.user, a.outlet.id, card.code)).balance).toBe(500);
  });

  it("refunds to store credit as a new card and records the cash sale in the drawer", async () => {
    const f = await fixture();
    await cash.openDrawer(f.user, f.outlet.id, 0);
    const sold = await gifts.issue(f.user, f.outlet.id, { amount: 300, paymentMode: "CASH" });
    expect((await cash.current(f.user, f.outlet.id))!.expectedCash).toBe(300);
    const order = await orders.create(f.user, f.input);
    await orders.settle(f.user, order.id, { payments: [{ mode: "CARD", amount: 105 }] });
    const res = await cash.refund(f.user, f.outlet.id, order.id, { amount: 50, mode: "GIFT_CARD", requestKey: "r1" });
    expect(res.status).toBe("PROCESSED");
    expect(res.gatewayRef).toMatch(/^SC/);
    expect(gateway.refund).not.toHaveBeenCalled();
    const credit = await gifts.balance(f.user, f.outlet.id, res.gatewayRef!);
    expect(credit).toMatchObject({ kind: "STORE_CREDIT", balance: 50, usable: true });
    expect(sold.kind).toBe("GIFT_CARD");
  });
});

describe("expenses and P&L", () => {
  it("flows drawer expenses into the book and aggregates a P&L with comparison", async () => {
    const f = await fixture();
    const today = new Date().toISOString().slice(0, 10);
    await cash.openDrawer(f.user, f.outlet.id, 1000);
    await cash.addMovement(f.user, f.outlet.id, { type: "EXPENSE", amount: 120, category: "Repairs", note: "Tap" });
    const rent = await finance.createCategory(f.user, { name: "Rent", isActive: true });
    await finance.createExpense(f.user, f.outlet.id, {
      categoryId: rent.id, date: today, taxableAmount: 1000, cgst: 90, sgst: 90, igst: 0, itcEligible: true, paidFrom: "BANK",
    });
    const drawerPaid = await finance.createExpense(f.user, f.outlet.id, {
      categoryId: rent.id, date: today, taxableAmount: 200, cgst: 0, sgst: 0, igst: 0, itcEligible: false, paidFrom: "CASH_DRAWER",
    });
    expect((await cash.current(f.user, f.outlet.id))!.expenses).toBe(320);
    const list = await finance.listExpenses(f.user, f.outlet.id, today, today);
    expect(list).toHaveLength(3);
    expect(list.find((e) => e.categoryName === "Repairs")?.fromDrawer).toBe(true);

    // Sales: two orders, one with a discount; one refund.
    for (const discount of [0, 10]) {
      const o = await orders.create(f.user, f.input);
      const total = discount ? 94.5 : 105;
      await orders.settle(f.user, o.id, { payments: [{ mode: "CASH", amount: total }], discountAmount: discount || undefined });
    }
    const settled = await prisma.order.findFirstOrThrow({ where: { tenantId: f.tenant.id, discountAmount: 0, status: "SETTLED" } });
    await cash.refund(f.user, f.outlet.id, settled.id, { amount: 21, mode: "CASH", requestKey: "k" });
    // COGS / wastage.
    const mat = await prisma.rawMaterial.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Rice", unit: "KG", costPerUnit: 50 } });
    await prisma.stockMovement.createMany({
      data: [
        { tenantId: f.tenant.id, outletId: f.outlet.id, rawMaterialId: mat.id, type: "CONSUMPTION", quantity: -2, unitCost: 40 },
        { tenantId: f.tenant.id, outletId: f.outlet.id, rawMaterialId: mat.id, type: "WASTAGE", quantity: -1 },
      ],
    });

    const pnl = await finance.pnl(f.user, f.outlet.id, today, today, "prev");
    expect(pnl.current).toMatchObject({
      grossSales: 200,
      discounts: 10,
      refunds: 20, // 21 refunded on a 105 bill carrying 5 tax → 20 net
      netSales: 170,
      taxCollected: 9.5,
      cogs: 80,
      wastage: 50,
      grossProfit: 40,
      totalExpenses: 1320, // 120 drawer + 1000 (ITC claimable) + 200 (no ITC)
      orders: 2,
    });
    expect(pnl.current.netProfit).toBe(40 - 1320);
    expect(pnl.compare?.orders).toBe(0);

    // Voiding a drawer-paid expense puts the cash back and drops it from the P&L.
    await finance.voidExpense(f.user, f.outlet.id, drawerPaid.id, "Duplicate");
    expect((await cash.current(f.user, f.outlet.id))!.payIns).toBe(200);
    expect((await finance.pnl(f.user, f.outlet.id, today, today, "none")).current.totalExpenses).toBe(1120);

    const book = await finance.dayBook(f.user, f.outlet.id, today, today);
    expect(book.entries.filter((e) => e.kind === "SALE")).toHaveLength(2);
    expect(book.entries.filter((e) => e.kind === "EXPENSE")).toHaveLength(2);
    const xml = await finance.tallyExpenses(f.user, f.outlet.id, today, today);
    expect(xml).toContain("<LEDGERNAME>Input CGST</LEDGERNAME>");
    expect(xml).toContain('VCHTYPE="Payment"');

    // Another tenant cannot see any of it.
    const other = await fixture("Other");
    expect((await finance.pnl(other.user, other.outlet.id, today, today, "none")).current.totalExpenses).toBe(0);
    await expect(finance.listExpenses(other.user, f.outlet.id, today, today)).rejects.toThrow("No access");
  });
});

describe("attendance and payroll", () => {
  async function staffFixture() {
    const f = await fixture();
    const s = await staffSvc.create(f.user, {
      outletId: f.outlet.id, employeeCode: "E1", name: "Ravi", joiningDate: "2026-01-01", payType: "MONTHLY", payRate: 30000,
      allowances: [], deductions: [], pfApplicable: false, esiApplicable: false, ptApplicable: false, overtimeEligible: true, isActive: true,
    });
    await staffSvc.setPin(f.user, s.id, "1234");
    return { ...f, staff: s };
  }

  it("clocks in/out with a PIN, locks after repeated wrong PINs, and serialises double taps", async () => {
    const f = await staffFixture();
    const t0 = istAt("2026-10-20", "09:00");
    for (let i = 0; i < 4; i++) {
      await expect(staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "0000", action: "IN" }, t0)).rejects.toThrow("Wrong PIN");
    }
    await expect(staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "0000", action: "IN" }, t0)).rejects.toThrow("locked");
    await expect(staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "1234", action: "IN" }, t0)).rejects.toThrow("Too many");
    const later = new Date(t0.getTime() + 6 * 60000);
    const taps = await Promise.allSettled(
      Array.from({ length: 4 }, () => staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "1234", action: "IN" }, later)),
    );
    expect(taps.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.attendanceRecord.count({ where: { staffId: f.staff.id, clockOut: null } })).toBe(1);
    await staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "1234", action: "BREAK_START" }, istAt("2026-10-20", "13:00"));
    await staffSvc.clock(f.user, f.outlet.id, { staffId: f.staff.id, pin: "1234", action: "OUT" }, istAt("2026-10-20", "13:45"));
    const rec = await prisma.attendanceRecord.findFirstOrThrow({ where: { staffId: f.staff.id } });
    expect(rec.breakMinutes).toBe(45);
    expect(rec.date.toISOString().slice(0, 10)).toBe("2026-10-20");
    // Other tenants cannot clock this person.
    const other = await fixture("Other");
    await expect(staffSvc.clock(other.user, f.outlet.id, { staffId: f.staff.id, pin: "1234", action: "IN" })).rejects.toThrow("No access");
  });

  it("computes a monthly payroll from roster, attendance, leave and advances, then locks it", async () => {
    const f = await staffFixture();
    const tpl = await roster.createTemplate(f.user, f.outlet.id, { name: "Day", startTime: "09:00", endTime: "18:00", breakMinutes: 60, graceMinutes: 10 });
    // Roster 3 days in September: worked (with 2h OT), sick leave, absent.
    await roster.assign(f.user, f.outlet.id, {
      entries: ["2026-09-01", "2026-09-02", "2026-09-03"].map((date) => ({ staffId: f.staff.id, date, templateId: tpl.id })),
    });
    await prisma.attendanceRecord.create({
      data: { tenantId: f.tenant.id, outletId: f.outlet.id, staffId: f.staff.id, date: d("2026-09-01"), clockIn: istAt("2026-09-01", "09:00"), clockOut: istAt("2026-09-01", "20:00"), breakMinutes: 60 },
    });
    await roster.setBalance(f.user, f.outlet.id, { staffId: f.staff.id, year: 2026, type: "SICK", allotted: 1 });
    const l1 = await roster.requestLeave(f.user, f.outlet.id, { staffId: f.staff.id, type: "SICK", fromDate: "2026-09-02", toDate: "2026-09-02", halfDay: false });
    await roster.decideLeave(f.user, f.outlet.id, l1.id, { approve: true });
    // A second sick-leave approval would overdraw the balance.
    const l2 = await roster.requestLeave(f.user, f.outlet.id, { staffId: f.staff.id, type: "SICK", fromDate: "2026-09-10", toDate: "2026-09-10", halfDay: false });
    await expect(roster.decideLeave(f.user, f.outlet.id, l2.id, { approve: true })).rejects.toThrow("Insufficient sick leave");
    await payroll.giveAdvance(f.user, f.outlet.id, { staffId: f.staff.id, amount: 3000, monthlyRecovery: 1000, givenOn: "2026-08-15", paidFrom: "BANK" });

    const run = await payroll.computeDraft(f.user, f.outlet.id, "2026-09");
    const p = run.payslips[0];
    expect(p.attendance).toMatchObject({ presentDays: 1, paidLeaveDays: 1, lopDays: 1, overtimeMinutes: 120 });
    // 30000/30 = 1000/day: 1 LOP day → 29000; OT 2h × (1000/8) × 2 = 500; advance 1000.
    expect(p.calc).toMatchObject({ basic: 29000, overtimePay: 500, gross: 29500, advanceRecovery: 1000, net: 28500 });

    const edited = await payroll.updatePayslip(f.user, f.outlet.id, run.id, p.id, { adjustments: [{ name: "Festival bonus", amount: 1000, kind: "EARNING" }] });
    expect(edited.calc.net).toBe(29500);
    // Recompute keeps the manual adjustment.
    expect((await payroll.computeDraft(f.user, f.outlet.id, "2026-09")).payslips[0].calc.net).toBe(29500);

    const final = await payroll.finalise(f.user, f.outlet.id, run.id);
    expect(final.status).toBe("FINALISED");
    const adv = await prisma.salaryAdvance.findFirstOrThrow({ where: { staffId: f.staff.id } });
    expect(Number(adv.recovered)).toBe(1000);
    await expect(payroll.finalise(f.user, f.outlet.id, run.id)).rejects.toThrow("already finalised");
    await expect(payroll.updatePayslip(f.user, f.outlet.id, run.id, p.id, { lopDays: 0 })).rejects.toThrow("locked");
    await expect(payroll.computeDraft(f.user, f.outlet.id, "2026-09")).rejects.toThrow("finalised");
    await expect(
      staffSvc.correct(f.user, f.outlet.id, { staffId: f.staff.id, clockIn: "2026-09-03T03:30:00.000Z", clockOut: "2026-09-03T12:30:00.000Z", breakMinutes: 0, reason: "Forgot" }),
    ).rejects.toThrow("finalised");

    // Payroll cost lands in the P&L, pro-rated by overlap.
    const pnl = await finance.pnl(f.user, f.outlet.id, "2026-09-01", "2026-09-30", "none");
    expect(pnl.current.payroll).toBe(30500);
    const half = await finance.pnl(f.user, f.outlet.id, "2026-09-01", "2026-09-15", "none");
    expect(half.current.payroll).toBe(15250);
    const csv = await payroll.csv(f.user, f.outlet.id, run.id);
    expect(csv.csv.split("\r\n")).toHaveLength(2);
  });

  it("does not double-approve leave under concurrency", async () => {
    const f = await staffFixture();
    await roster.setBalance(f.user, f.outlet.id, { staffId: f.staff.id, year: 2026, type: "CASUAL", allotted: 2 });
    const reqs = [];
    for (const day of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
      reqs.push(await roster.requestLeave(f.user, f.outlet.id, { staffId: f.staff.id, type: "CASUAL", fromDate: day, toDate: day, halfDay: false }));
    }
    const res = await Promise.allSettled(reqs.map((r) => roster.decideLeave(f.user, f.outlet.id, r.id, { approve: true })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const bal = await prisma.leaveBalance.findFirstOrThrow({ where: { staffId: f.staff.id, type: "CASUAL" } });
    expect(Number(bal.used)).toBe(2);
  });
});
