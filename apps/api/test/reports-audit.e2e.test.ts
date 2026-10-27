import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import ExcelJS from "exceljs";
import { AppModule } from "../src/app.module";
import { EMAIL_PROVIDER, type EmailAttachment } from "../src/email/email.provider";
import { ReportSchedulesService, computeNextRun, reportWindow } from "../src/report-export/report-schedules.service";
import { safeText } from "../src/report-export/report-writer";
import { testPrisma } from "./db";
import { seedTenant } from "./platform-helpers";

const jwt = new JwtService({ secret: "dev-secret-change-me" });
const tokenFor = (u: { id: string; tenantId: string }) => jwt.signAsync({ sub: u.id, tenantId: u.tenantId, tokenVersion: 0 });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("report export, schedules and audit log", () => {
  let app: INestApplication;
  const sent: { to: string[]; subject: string; attachments: EmailAttachment[] }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_PROVIDER)
      .useValue({
        sendVerification: async () => {},
        sendPasswordReset: async () => {},
        sendInvite: async () => {},
        sendReport: async (to: string[], subject: string, _t: string, attachments: EmailAttachment[]) => {
          sent.push({ to, subject, attachments });
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  async function seedSales() {
    const t = await seedTenant();
    const cat = await testPrisma.menuCategory.create({ data: { tenantId: t.tenant.id, outletId: t.outlet.id, name: "Mains" } });
    const item = await testPrisma.item.create({ data: { tenantId: t.tenant.id, outletId: t.outlet.id, categoryId: cat.id, name: "=HYPERLINK(\"x\")", price: 100 } });
    const order = await testPrisma.order.create({
      data: { tenantId: t.tenant.id, outletId: t.outlet.id, orderType: "TAKEAWAY", status: "SETTLED", subtotal: 200, taxAmount: 10, total: 210, billNumber: "B-1" },
    });
    await testPrisma.orderItem.create({ data: { orderId: order.id, itemId: item.id, itemName: item.name, quantity: 2, unitPrice: 100, lineTotal: 200, taxRate: 5 } });
    await testPrisma.orderPayment.create({ data: { orderId: order.id, mode: "UPI", amount: 210 } });
    return t;
  }

  it("CSV export: BOM, header, data and formula-injection guard", async () => {
    const { owner, outlet } = await seedSales();
    const today = ymd(new Date());
    const res = await http()
      .get(`/api/v1/outlets/${outlet.id}/reports/export?report=top-items&format=csv&from=${today}&to=${today}`)
      .set("Authorization", `Bearer ${await tokenFor(owner)}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="stello-top-items-/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("Item,Category,Qty,Revenue (₹)");
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",Mains,2,200`);
    expect(safeText("-1+2")).toBe("'-1+2");
  });

  it("XLSX export of every report produces a workbook with a sheet per table", async () => {
    const { owner, outlet } = await seedSales();
    const today = ymd(new Date());
    const res = await http()
      .get(`/api/v1/outlets/${outlet.id}/reports/export?report=all&format=xlsx&from=${today}&to=${today}`)
      .set("Authorization", `Bearer ${await tokenFor(owner)}`)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["Summary", "Sales by day", "Payment modes", "Top items", "GST summary", "Fraud watch", "Cash drawers", "Outlets"]));
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getRow(4).getCell(2).value).toBe(210); // gross sales
  });

  it("custom builder export and permission gating", async () => {
    const { owner, outlet, addUser } = await seedSales();
    const today = ymd(new Date());
    const res = await http()
      .post(`/api/v1/outlets/${outlet.id}/reports/export/custom?format=csv`)
      .set("Authorization", `Bearer ${await tokenFor(owner)}`)
      .send({ from: today, to: today, dimension: "paymentMode", metric: "revenue" });
    expect(res.status).toBe(201);
    expect(res.text).toContain("UPI,210,1");
    const { user: viewer } = await addUser("v@t.test", ["reports.view"]);
    const denied = await http()
      .get(`/api/v1/outlets/${outlet.id}/reports/export?report=overview`)
      .set("Authorization", `Bearer ${await tokenFor(viewer)}`);
    expect(denied.status).toBe(403);
    const other = await seedTenant("Other");
    const foreign = await http()
      .get(`/api/v1/outlets/${other.outlet.id}/reports/export?report=overview`)
      .set("Authorization", `Bearer ${await tokenFor(owner)}`);
    expect(foreign.status).toBe(403);
  });

  it("schedule maths: next run and reporting window", () => {
    const at = new Date(2026, 9, 26, 9, 30); // Mon 26 Oct 2026 09:30 local
    expect(computeNextRun({ frequency: "DAILY", weekday: null, hour: 8 }, at)).toEqual(new Date(2026, 9, 27, 8));
    expect(computeNextRun({ frequency: "DAILY", weekday: null, hour: 10 }, at)).toEqual(new Date(2026, 9, 26, 10));
    expect(computeNextRun({ frequency: "WEEKLY", weekday: 1, hour: 8 }, at)).toEqual(new Date(2026, 10, 2, 8));
    expect(computeNextRun({ frequency: "WEEKLY", weekday: 3, hour: 8 }, at)).toEqual(new Date(2026, 9, 28, 8));
    expect(reportWindow("DAILY", at)).toEqual({ from: "2026-10-25", to: "2026-10-25" });
    expect(reportWindow("WEEKLY", at)).toEqual({ from: "2026-10-19", to: "2026-10-25" });
  });

  it("due schedules are claimed once and emailed with an attachment", async () => {
    const { owner, outlet } = await seedSales();
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const created = await http()
      .post(`/api/v1/outlets/${outlet.id}/report-schedules`)
      .set(auth)
      .send({ name: "Morning numbers", frequency: "DAILY", hour: 8, recipients: ["Boss@Example.com"], reports: ["overview", "top-items"], format: "CSV" });
    expect(created.status).toBe(201);
    expect(created.body.recipients).toEqual(["boss@example.com"]);
    await testPrisma.reportSchedule.update({ where: { id: created.body.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });

    const svc = app.get(ReportSchedulesService);
    sent.length = 0;
    const [a, b] = await Promise.all([svc.runDue(), svc.runDue()]);
    expect(a + b).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["boss@example.com"]);
    expect(sent[0].subject).toContain("Morning numbers");
    expect(sent[0].attachments[0].filename).toMatch(/\.csv$/);
    const row = await testPrisma.reportSchedule.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.lastStatus).toBe("SENT");
    expect(row.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    const now = await http().post(`/api/v1/outlets/${outlet.id}/report-schedules/${created.body.id}/send-now`).set(auth);
    expect(now.status).toBe(200);
    expect(sent).toHaveLength(2);

    const bad = await http()
      .post(`/api/v1/outlets/${outlet.id}/report-schedules`)
      .set(auth)
      .send({ name: "x", frequency: "WEEKLY", hour: 8, recipients: ["a@b.co"], reports: ["overview"] });
    expect(bad.status).toBe(400);
  });

  it("audit log: filters, keyset pagination, detail and tenant isolation", async () => {
    const { owner, tenant } = await seedTenant("Audit A");
    const other = await seedTenant("Audit B");
    const base = Date.now() - 10_000;
    for (let i = 0; i < 7; i++) {
      await testPrisma.auditLog.create({
        data: { tenantId: tenant.id, userId: owner.id, action: i % 2 ? "ORDER_SETTLED" : "ORDER_CREATED", entity: "order", entityId: `o${i}`, createdAt: new Date(base + i * 1000), data: { i } },
      });
    }
    await testPrisma.auditLog.create({ data: { tenantId: other.tenant.id, action: "ORDER_CREATED", entity: "order" } });
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };

    const p1 = await http().get("/api/v1/audit-logs?limit=3").set(auth);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((x: { entityId: string }) => x.entityId)).toEqual(["o6", "o5", "o4"]);
    const p2 = await http().get(`/api/v1/audit-logs?limit=3&cursor=${p1.body.nextCursor}`).set(auth);
    expect(p2.body.items.map((x: { entityId: string }) => x.entityId)).toEqual(["o3", "o2", "o1"]);
    const p3 = await http().get(`/api/v1/audit-logs?limit=3&cursor=${p2.body.nextCursor}`).set(auth);
    expect(p3.body.items.map((x: { entityId: string }) => x.entityId)).toEqual(["o0"]);
    expect(p3.body.nextCursor).toBeNull();

    const settled = await http().get("/api/v1/audit-logs?action=ORDER_SETTLED").set(auth);
    expect(settled.body.items).toHaveLength(3);
    const byActor = await http().get(`/api/v1/audit-logs?actorId=${owner.id}&entity=order`).set(auth);
    expect(byActor.body.items).toHaveLength(7);
    expect(byActor.body.items[0].actor.email).toBe(owner.email);
    const future = await http().get("/api/v1/audit-logs?from=2999-01-01").set(auth);
    expect(future.body.items).toHaveLength(0);

    const detail = await http().get(`/api/v1/audit-logs/${p1.body.items[0].id}`).set(auth);
    expect(detail.body.data).toEqual({ i: 6 });
    const foreignId = (await testPrisma.auditLog.findFirstOrThrow({ where: { tenantId: other.tenant.id } })).id;
    expect((await http().get(`/api/v1/audit-logs/${foreignId}`).set(auth)).status).toBe(404);

    const facets = await http().get("/api/v1/audit-logs/facets").set(auth);
    expect(facets.body.actions).toEqual(["ORDER_CREATED", "ORDER_SETTLED"]);
    expect((await http().get("/api/v1/audit-logs?cursor=garbage").set(auth)).status).toBe(400);
  });
});
