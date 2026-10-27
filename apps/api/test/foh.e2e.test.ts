import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { testPrisma } from "./db";

/**
 * Front of house over HTTP against the booted app: permission gating of the
 * new routes, the multipart menu-photo upload (multer limits + validation) and
 * the public diner "call a server" endpoints.
 */
const mediaDir = mkdtempSync(join(tmpdir(), "stello-e2e-media-"));
process.env.MEDIA_DIR = mediaDir;

function png(width: number, height: number, extra = 0) {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("front of house e2e", () => {
  let app: INestApplication;
  let ownerToken: string;
  let waiterToken: string;
  let ids: { outletId: string; itemId: string; tableId: string; tableToken: string; areaId: string };

  beforeAll(async () => {
    const { AppModule } = await import("../src/app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const passwordHash = await bcrypt.hash("password123", 4);
    const tenant = await testPrisma.tenant.create({ data: { name: "FOH e2e", status: "ACTIVE" } });
    const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
    const outlet = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet" } });
    const owner = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
    const waiter = await testPrisma.role.create({
      data: { tenantId: tenant.id, name: "Waiter", permissions: ["orders.create", "captain.operate", "reservations.manage"] },
    });
    for (const [email, roleId] of [["owner@foh.test", owner.id], ["waiter@foh.test", waiter.id]] as const) {
      await testPrisma.user.create({
        data: { tenantId: tenant.id, email, passwordHash, name: email, roleId, userOutlets: { create: [{ outletId: outlet.id }] } },
      });
    }
    const category = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
    const item = await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Dosa", price: 90 } });
    const area = await testPrisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
    const table = await testPrisma.diningTable.create({
      data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T1", publicToken: "e2e-table-token" },
    });
    ids = { outletId: outlet.id, itemId: item.id, tableId: table.id, tableToken: "e2e-table-token", areaId: area.id };
    const login = (email: string) =>
      request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "password123" }).then((r) => r.body.accessToken as string);
    ownerToken = await login("owner@foh.test");
    waiterToken = await login("waiter@foh.test");
  });

  const http = () => request(app.getHttpServer());

  it("uploads, serves and validates menu photos behind menu.manage", async () => {
    const url = `/api/v1/outlets/${ids.outletId}/menu/items/${ids.itemId}/image`;
    await http().post(url).set("Authorization", `Bearer ${waiterToken}`).attach("file", png(10, 10), "a.png").expect(403);

    const ok = await http().post(url).set("Authorization", `Bearer ${ownerToken}`).attach("file", png(640, 480), "dish.png").expect(201);
    expect(ok.body).toMatchObject({ width: 640, height: 480 });
    const served = await http().get(ok.body.imageUrl).expect(200);
    expect(served.headers["content-type"]).toBe("image/png");

    // Spoofed type: an SVG named .png is rejected by content sniffing.
    await http().post(url).set("Authorization", `Bearer ${ownerToken}`).attach("file", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>".padEnd(64)), { filename: "x.png", contentType: "image/png" }).expect(400);
    // Too large: stopped by the multer limit before it is buffered entirely.
    await http().post(url).set("Authorization", `Bearer ${ownerToken}`).attach("file", png(10, 10, 3 * 1024 * 1024), "big.png").expect(413);
    await http().get("/api/v1/media/items/x/..%2F..%2Fsecret.png").expect(404);

    const menu = await http().get(`/api/v1/outlets/${ids.outletId}/menu`).set("Authorization", `Bearer ${waiterToken}`).expect(200);
    expect(menu.body[0].items[0].imageUrl).toBe(ok.body.imageUrl);
    const diner = await http().get(`/api/v1/public/scan/t/${ids.tableToken}`).expect(200);
    expect(diner.body.categories[0].items[0].imageUrl).toBe(ok.body.imageUrl);
  });

  it("records diner calls (new + legacy endpoint) and gates staff routes", async () => {
    const water = await http().post(`/api/v1/public/scan/t/${ids.tableToken}/server-call`).send({ type: "WATER" }).expect(201);
    expect(water.body.tableName).toBe("T1");
    await http().post(`/api/v1/public/scan/t/${ids.tableToken}/server-call`).send({ type: "DANCE" }).expect(400);
    await http().post(`/api/v1/public/scan/t/${ids.tableToken}/call-waiter`).expect(201);

    const calls = await http().get(`/api/v1/outlets/${ids.outletId}/server-calls`).set("Authorization", `Bearer ${waiterToken}`).expect(200);
    expect(calls.body.map((c: { type: string }) => c.type).sort()).toEqual(["WAITER", "WATER"]);
    await http().post(`/api/v1/outlets/${ids.outletId}/server-calls/${water.body.callId}/acknowledge`).set("Authorization", `Bearer ${waiterToken}`).expect(201);

    // Waiters can book tables but not redraw the floor or pair displays.
    await http()
      .post(`/api/v1/outlets/${ids.outletId}/reservations`)
      .set("Authorization", `Bearer ${waiterToken}`)
      .send({ guestName: "Asha", phone: "9876543210", partySize: 2, startAt: "2030-01-15T19:00:00Z", tableIds: [ids.tableId] })
      .expect(201);
    await http()
      .put(`/api/v1/outlets/${ids.outletId}/floor/areas/${ids.areaId}/plan`)
      .set("Authorization", `Bearer ${waiterToken}`)
      .send({ width: 800, height: 600, tables: [] })
      .expect(403);
    await http().post(`/api/v1/outlets/${ids.outletId}/cfd/pair`).set("Authorization", `Bearer ${waiterToken}`).send({ code: "123456" }).expect(403);
    // Owner layout save rejects overlapping tables at the schema level.
    await http()
      .put(`/api/v1/outlets/${ids.outletId}/floor/areas/${ids.areaId}/plan`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        width: 800,
        height: 600,
        tables: [
          { tableId: ids.tableId, name: "T1", seats: 4, shape: "SQUARE", x: 0, y: 0, width: 100, height: 100, rotation: 0 },
          { name: "T2", seats: 4, shape: "SQUARE", x: 50, y: 50, width: 100, height: 100, rotation: 0 },
        ],
      })
      .expect(400);
    const floor = await http().get(`/api/v1/outlets/${ids.outletId}/floor`).set("Authorization", `Bearer ${waiterToken}`).expect(200);
    expect(floor.body.areas[0].tables[0].openCalls.sort()).toEqual(["WAITER", "WATER"]);
  });
});
