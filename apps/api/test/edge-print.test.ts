import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { AppModule } from "../src/app.module";
import { testPrisma } from "./db";

// The edge sidecar's print agent drains the cloud print queue with its device
// token (no user session). Device routes must stay pinned to the device's own
// tenant + outlet and record the device as the claimant.
let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();
});
afterAll(async () => {
  await app.close();
});

async function fixture(label: string) {
  const tenant = await testPrisma.tenant.create({ data: { name: label, status: "ACTIVE" } });
  const owner = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: label } });
  const outlet = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: `${label} Main` } });
  const outlet2 = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: `${label} Second` } });
  const admin = await testPrisma.user.create({
    data: {
      tenantId: tenant.id,
      roleId: owner.id,
      name: "Owner",
      email: `owner-${tenant.id}@t.test`,
      passwordHash: "unused",
      userOutlets: { create: [{ outletId: outlet.id }, { outletId: outlet2.id }] },
    },
  });
  await testPrisma.terminal.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Counter", type: "POS" } });
  const adminToken = await app.get(JwtService).signAsync({ sub: admin.id, tenantId: tenant.id, tokenVersion: 0 });
  const lan = await testPrisma.printer.create({
    data: { tenantId: tenant.id, outletId: outlet.id, name: "Kitchen LAN", connection: "NETWORK", host: "192.168.1.50", printKots: true },
  });
  const otherOutletPrinter = await testPrisma.printer.create({
    data: { tenantId: tenant.id, outletId: outlet2.id, name: "Second LAN", connection: "NETWORK", host: "192.168.1.60", printKots: true },
  });
  const job = (outletId: string, printerId: string) =>
    testPrisma.printJob.create({ data: { tenantId: tenant.id, outletId, printerId, kind: "TEST", payload: { kind: "TEST" } } });
  return { tenant, outlet, outlet2, adminToken, lan, otherOutletPrinter, job };
}

async function activate(f: Awaited<ReturnType<typeof fixture>>) {
  const res = await http()
    .post(`/api/v1/outlets/${f.outlet.id}/edge/activate`)
    .set("authorization", `Bearer ${f.adminToken}`)
    .send({})
    .expect(201);
  return res.body as { edgeDeviceId: string; deviceToken: string };
}

describe("edge device print queue", () => {
  it("claims only its own outlet's jobs as the device and reports results", async () => {
    const f = await fixture("EdgePrintA");
    const dev = await activate(f);
    const mine = await f.job(f.outlet.id, f.lan.id);
    const otherOutlet = await f.job(f.outlet2.id, f.otherOutletPrinter.id);

    const claimed = await http()
      .post("/api/v1/edge/device/print-jobs/claim")
      .set("authorization", `Device ${dev.deviceToken}`)
      // A spoofed agent id in the body is ignored: the claimant is the device.
      .send({ agentId: "spoofed", connections: ["NETWORK", "USB"], limit: 10 })
      .expect(201);
    expect(claimed.body.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    expect((await testPrisma.printJob.findUniqueOrThrow({ where: { id: mine.id } })).claimedBy).toBe(dev.edgeDeviceId);
    expect((await testPrisma.printJob.findUniqueOrThrow({ where: { id: otherOutlet.id } })).status).toBe("QUEUED");

    await http()
      .post(`/api/v1/edge/device/print-jobs/${mine.id}/complete`)
      .set("authorization", `Device ${dev.deviceToken}`)
      .send({ ok: true, agentId: "spoofed" })
      .expect(201);
    expect((await testPrisma.printJob.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("PRINTED");
  });

  it("cannot complete another outlet's or tenant's job, and needs a device token", async () => {
    const f = await fixture("EdgePrintB");
    const other = await fixture("EdgePrintC");
    const dev = await activate(f);
    const foreignOutletJob = await f.job(f.outlet2.id, f.otherOutletPrinter.id);
    const foreignTenantJob = await other.job(other.outlet.id, other.lan.id);
    for (const job of [foreignOutletJob, foreignTenantJob]) {
      await http()
        .post(`/api/v1/edge/device/print-jobs/${job.id}/complete`)
        .set("authorization", `Device ${dev.deviceToken}`)
        .send({ ok: true })
        .expect(404);
    }
    await http().post("/api/v1/edge/device/print-jobs/claim").send({ agentId: "x" }).expect(401);
    await http()
      .post("/api/v1/edge/device/print-jobs/claim")
      .set("authorization", `Bearer ${f.adminToken}`)
      .send({ agentId: "x" })
      .expect(401);
  });
});
