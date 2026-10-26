import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthUser, BillDto, KotTicketDto } from "@stello/shared";
import { CreatePrinterSchema } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { PrintingService } from "../src/printing/printing.service";

const prisma = new PrismaService();
const emit = vi.fn();
const realtime = { notifyOutlet: vi.fn(), server: { to: () => ({ emit }) } };
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const printing = new PrintingService(prisma, realtime as any);

// The printing service listens to order events exactly as it does when Nest boots it.
beforeAll(() => printing.onModuleInit());
afterAll(async () => {
  printing.onModuleDestroy();
  await prisma.$disconnect();
});

async function fixture(name = "Print") {
  const tenant = await prisma.tenant.create({ data: { name } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({
    data: { tenantId: tenant.id, roleId: role.id, name: "Ravi", email: `${tenant.id}@example.com`, passwordHash: "x" },
  });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Stello" } });
  const outlet = await prisma.outlet.create({
    data: { tenantId: tenant.id, brandId: brand.id, name: "Koramangala", gstin: "29ABCDE1234F1Z5", upiVpa: "stello@okhdfc" },
  });
  const tandoor = await prisma.station.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Tandoor" } });
  const bar = await prisma.station.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Bar" } });
  const mains = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Mains", stationId: tandoor.id } });
  const drinks = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Drinks", stationId: bar.id } });
  const naan = await prisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: mains.id, name: "Butter Naan", price: 100, taxRate: 5 } });
  const lassi = await prisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: drinks.id, name: "Lassi", price: 200, taxRate: 18 } });
  const user: AuthUser = {
    id: actor.id, tenantId: tenant.id, email: actor.email, name: "Ravi", roleName: "Owner",
    permissions: ["*"], outletIds: [outlet.id], isPlatformAdmin: false,
  };
  const printer = (data: Record<string, unknown>) =>
    printing.createPrinter(user, outlet.id, CreatePrinterSchema.parse({ connection: "NETWORK", host: "192.168.1.50", ...data }));
  return { tenant, outlet, tandoor, bar, naan, lassi, user, printer };
}

const takeaway = (f: Awaited<ReturnType<typeof fixture>>) => ({
  outletId: f.outlet.id,
  orderType: "TAKEAWAY" as const,
  items: [
    { itemId: f.naan.id, quantity: 2, addonIds: [], note: "extra butter" },
    { itemId: f.lassi.id, quantity: 1, addonIds: [] },
  ],
  combos: [],
});

const kotOf = (job: { payload: unknown }) => (job.payload as { ticket: KotTicketDto }).ticket;
const billOf = (job: { payload: unknown }) => (job.payload as { bill: BillDto }).bill;

describe("automatic KOT jobs", () => {
  it("routes a punched KOT to station printers and never duplicates", async () => {
    const f = await fixture();
    const tandoorPrinter = await f.printer({ name: "Tandoor", printKots: true, stationIds: [f.tandoor.id] });
    const expo = await f.printer({ name: "Expo", printKots: true });
    await f.printer({ name: "Bills", printBills: true });
    await f.printer({ name: "Manual KOT", printKots: true, autoPrintKot: false });

    const order = await orders.create(f.user, takeaway(f));
    const jobs = await prisma.printJob.findMany({ where: { orderId: order.id } });
    expect(jobs).toHaveLength(2);
    const tandoorTicket = kotOf(jobs.find((j) => j.printerId === tandoorPrinter.id)!);
    expect(tandoorTicket.items.map((i) => i.name)).toEqual(["Butter Naan"]);
    expect(tandoorTicket.stationName).toBe("Tandoor");
    expect(tandoorTicket.items[0].note).toBe("extra butter");
    expect(tandoorTicket.staffName).toBe("Ravi");
    expect(tandoorTicket.source).toBe("POS");
    const expoTicket = kotOf(jobs.find((j) => j.printerId === expo.id)!);
    expect(expoTicket.items.map((i) => i.name).sort()).toEqual(["Butter Naan", "Lassi"]);
    expect(expoTicket.stationName).toBeNull();
    expect(jobs.every((j) => j.status === "QUEUED" && j.kind === "KOT" && !j.reprint)).toBe(true);
    expect(emit).toHaveBeenCalledWith("print:queued", expect.objectContaining({ outletId: f.outlet.id }));

    // Re-delivered event: idempotent.
    await printing.onOrderEvent({ type: "kot.created", tenantId: f.tenant.id, outletId: f.outlet.id, orderId: order.id, userId: f.user.id });
    expect(await prisma.printJob.count({ where: { orderId: order.id } })).toBe(2);

    // Adding items prints only the new KOT.
    await orders.addItems(f.user, order.id, { items: [{ itemId: f.lassi.id, quantity: 3, addonIds: [] }], combos: [] });
    const after = await prisma.printJob.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(after).toHaveLength(3); // tandoor printer has nothing for a Lassi-only KOT
    expect(kotOf(after[2]).items).toEqual([expect.objectContaining({ name: "Lassi", quantity: 3 })]);
  });

  it("marks scan orders and prints cancellation tickets when an order is voided", async () => {
    const f = await fixture();
    await f.printer({ name: "Expo", printKots: true });
    const scan = await orders.ingestScanOrder({
      tenantId: f.tenant.id, outletId: f.outlet.id, mode: "TAKEAWAY", items: takeaway(f).items,
    });
    const [scanJob] = await prisma.printJob.findMany({ where: { orderId: scan.orderId } });
    expect(kotOf(scanJob).source).toBe("SCAN");

    const order = await orders.create(f.user, takeaway(f));
    await orders.cancel(f.user, order.id);
    const jobs = await prisma.printJob.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(jobs).toHaveLength(2);
    expect(kotOf(jobs[1]).cancelled).toBe(true);
    expect(kotOf(jobs[1]).items.map((i) => i.quantity).sort()).toEqual([1, 2]);
  });

  it("creates nothing when no printer wants KOTs", async () => {
    const f = await fixture();
    await f.printer({ name: "Bills", printBills: true });
    const order = await orders.create(f.user, takeaway(f));
    expect(await prisma.printJob.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("bills", () => {
  it("prints the tax invoice and kicks the drawer on a cash settlement", async () => {
    const f = await fixture();
    const counter = await f.printer({ name: "Counter", printBills: true, drawerKick: true, copies: 2 });
    await printing.updateSettings(f.user, f.outlet.id, { fssaiNumber: "12345678901234", footerLines: ["Come again"] });
    const order = await orders.create(f.user, takeaway(f));
    // 2×100 @5% + 200 @18% = 400 + 10 + 36 tax
    await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 446 }] });
    const [job] = await prisma.printJob.findMany({ where: { orderId: order.id, kind: "BILL" } });
    expect(job.printerId).toBe(counter.id);
    expect(job.openDrawer).toBe(true);
    expect(job.copies).toBe(2);
    const bill = billOf(job);
    expect(bill.billNumber).toBe("B-1");
    expect(bill.provisional).toBe(false);
    expect(bill.fssaiNumber).toBe("12345678901234");
    expect(bill.footerLines).toEqual(["Come again"]);
    expect(bill.upiQr).toBeNull(); // paid: no scan-to-pay
    expect(bill.taxLines).toEqual([
      { label: "CGST", ratePercent: 2.5, amount: 5 },
      { label: "SGST", ratePercent: 2.5, amount: 5 },
      { label: "CGST", ratePercent: 9, amount: 18 },
      { label: "SGST", ratePercent: 9, amount: 18 },
    ]);
    expect(bill.total).toBe(446);
    expect(bill.payments).toEqual([{ mode: "CASH", amount: 446 }]);

    // Manual print after an auto print is a DUPLICATE.
    const [dup] = await printing.printBill(f.user, f.outlet.id, order.id, {});
    expect(dup.reprint).toBe(true);
    expect(billOf(dup).reprint).toBe(true);
    expect(dup.openDrawer).toBe(false);
  });

  it("card settlements don't kick; a pre-bill is pro-forma with a UPI QR", async () => {
    const f = await fixture();
    await f.printer({ name: "Counter", printBills: true, drawerKick: true, autoPrintBill: false });
    const order = await orders.create(f.user, takeaway(f));
    const [pre] = await printing.printBill(f.user, f.outlet.id, order.id, {});
    expect(billOf(pre).provisional).toBe(true);
    expect(billOf(pre).billNumber).toBeNull();
    expect(billOf(pre).upiQr).toMatch(/^upi:\/\/pay\?pa=stello%40okhdfc&.*am=446\.00/);
    await orders.settle(f.user, order.id, { payments: [{ mode: "CARD", amount: 446 }] });
    expect(await prisma.printJob.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe("job lifecycle", () => {
  it("hands each job to exactly one of many concurrent claimants", async () => {
    const f = await fixture();
    await f.printer({ name: "Expo", printKots: true });
    for (let i = 0; i < 4; i++) await orders.create(f.user, takeaway(f));
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => printing.claim(f.user, f.outlet.id, { agentId: `agent-${i}`, limit: 3 })),
    );
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    const claimed = claims.flat()[0];
    expect(claimed.printer?.host).toBe("192.168.1.50");
    expect(claimed.status).toBe("PRINTING");
    expect(await printing.claim(f.user, f.outlet.id, { agentId: "late" })).toEqual([]);
  });

  it("filters claims by connection, printer and creator", async () => {
    const f = await fixture();
    const browser = await f.printer({ name: "Screen", connection: "BROWSER", host: null, printKots: true });
    await f.printer({ name: "LAN", printKots: true });
    await orders.create(f.user, takeaway(f));
    await orders.ingestScanOrder({ tenantId: f.tenant.id, outletId: f.outlet.id, mode: "TAKEAWAY", items: takeaway(f).items });

    expect(await printing.claim(f.user, f.outlet.id, { agentId: "fallback", olderThanSeconds: 60 })).toEqual([]);
    const mine = await printing.claim(f.user, f.outlet.id, { agentId: "pos", printerIds: [browser.id], mine: true });
    expect(mine).toHaveLength(1);
    expect(kotOf(mine[0]).source).toBe("POS");
    const agent = await printing.claim(f.user, f.outlet.id, { agentId: "edge", connections: ["NETWORK", "USB"], limit: 10 });
    expect(agent).toHaveLength(2);
    expect(agent.every((j) => j.printer?.connection === "NETWORK")).toBe(true);
    expect(await printing.claim(f.user, f.outlet.id, { agentId: "pos", printerIds: [] })).toEqual([]);
  });

  it("completes, fails, retries, re-offers stale claims and reprints", async () => {
    const f = await fixture();
    const p = await f.printer({ name: "Expo", printKots: true });
    const job = await printing.testPrint(f.user, f.outlet.id, p.id);
    expect(job.kind).toBe("TEST");

    let [claimed] = await printing.claim(f.user, f.outlet.id, { agentId: "a1" });
    await expect(printing.complete(f.user, claimed.id, { ok: true, agentId: "a2" })).rejects.toThrow("another printer agent");
    const failed = await printing.complete(f.user, claimed.id, { ok: false, error: "ECONNREFUSED 192.168.1.50:9100", agentId: "a1" });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain("ECONNREFUSED");
    await expect(printing.complete(f.user, claimed.id, { ok: true })).rejects.toThrow("not printing");

    expect((await printing.retry(f.user, claimed.id)).status).toBe("QUEUED");
    [claimed] = await printing.claim(f.user, f.outlet.id, { agentId: "a1" });
    expect(claimed.attempts).toBe(2);

    // The agent died mid-job: after the stale window the job is offered again.
    await prisma.printJob.update({ where: { id: claimed.id }, data: { claimedAt: new Date(Date.now() - 5 * 60_000) } });
    const [again] = await printing.claim(f.user, f.outlet.id, { agentId: "a2" });
    expect(again.id).toBe(claimed.id);
    // The original claimant's late result is ignored.
    await expect(printing.complete(f.user, claimed.id, { ok: true, agentId: "a1" })).rejects.toThrow();
    const done = await printing.complete(f.user, again.id, { ok: true, agentId: "a2" });
    expect(done.status).toBe("PRINTED");
    expect(done.printedAt).not.toBeNull();

    const order = await orders.create(f.user, takeaway(f));
    const [kotJob] = await printing.listJobs(f.user, f.outlet.id, "QUEUED", order.id);
    const re = await printing.reprint(f.user, kotJob.id);
    expect(re.id).not.toBe(kotJob.id);
    expect(re.reprint).toBe(true);
    expect(kotOf(re).reprint).toBe(true);
    expect(kotOf(re).kotNumber).toBe(kotOf(kotJob).kotNumber);

    const kot = await prisma.kot.findFirstOrThrow({ where: { orderId: order.id } });
    const manual = await printing.printKot(f.user, f.outlet.id, kot.id, {});
    expect(manual.map((j) => kotOf(j).reprint)).toEqual([true]);
  });

  it("cancels undelivered jobs when their printer is removed", async () => {
    const f = await fixture();
    const p = await f.printer({ name: "Expo", printKots: true });
    const order = await orders.create(f.user, takeaway(f));
    await printing.deletePrinter(f.user, f.outlet.id, p.id);
    const [job] = await prisma.printJob.findMany({ where: { orderId: order.id } });
    expect(job.status).toBe("CANCELLED");
    expect(job.printerId).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("never exposes or lets another tenant act on an outlet's printers and jobs", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    const p = await a.printer({ name: "Expo", printKots: true });
    const order = await orders.create(a.user, takeaway(a));
    const [job] = await prisma.printJob.findMany({ where: { orderId: order.id } });

    await expect(printing.listPrinters(b.user, a.outlet.id)).rejects.toThrow("No access");
    await expect(printing.claim(b.user, a.outlet.id, { agentId: "x" })).rejects.toThrow("No access");
    await expect(printing.complete(b.user, job.id, { ok: true })).rejects.toThrow("not found");
    await expect(printing.reprint(b.user, job.id)).rejects.toThrow("not found");
    await expect(printing.retry(b.user, job.id)).rejects.toThrow("not found");
    await expect(printing.updatePrinter(b.user, b.outlet.id, p.id, { name: "mine" })).rejects.toThrow("not found");
    await expect(printing.printBill(b.user, b.outlet.id, order.id, {})).rejects.toThrow();

    // Even a forged outlet list can't reach another tenant's rows: every query is tenant-scoped.
    const forged = { ...b.user, outletIds: [a.outlet.id] };
    expect(await printing.claim(forged, a.outlet.id, { agentId: "x" })).toEqual([]);
    expect(await printing.listJobs(forged, a.outlet.id)).toEqual([]);
    expect(await printing.listPrinters(forged, a.outlet.id)).toEqual([]);
    await expect(printing.printKot(forged, a.outlet.id, job.kotId!, { printerId: p.id })).rejects.toThrow("not found");
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");

    // Stations of another outlet can't be mapped.
    await expect(a.printer({ name: "Bad", printKots: true, stationIds: [b.tandoor.id] })).rejects.toThrow("Unknown station");
  });
});

describe("printer validation", () => {
  it("requires a host for network and a path for USB printers", () => {
    expect(CreatePrinterSchema.safeParse({ name: "X", connection: "NETWORK" }).success).toBe(false);
    expect(CreatePrinterSchema.safeParse({ name: "X", connection: "USB" }).success).toBe(false);
    expect(CreatePrinterSchema.safeParse({ name: "X", connection: "NETWORK", host: "10.0.0.5; rm" }).success).toBe(false);
    expect(CreatePrinterSchema.safeParse({ name: "X", connection: "BROWSER" }).success).toBe(true);
  });
});
