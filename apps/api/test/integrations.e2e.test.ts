import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testPrisma } from "./db";
import { bootApp, seedTenant } from "./platform-helpers";
import { WebhooksService } from "../src/webhooks/webhooks.service";
import { domainEvents, emitDomainEvent } from "../src/events/domain-events";
import { verifyWebhookSignature, signWebhook, nextRetryDelay, MAX_ATTEMPTS } from "../src/webhooks/webhook-signing";

const jwt = new JwtService({ secret: "dev-secret-change-me" });
const tokenFor = (u: { id: string; tenantId: string }) => jwt.signAsync({ sub: u.id, tenantId: u.tenantId, tokenVersion: 0 });

/** A local receiver that records requests and answers with a scripted status. */
async function receiver(statuses: number[] = [200]) {
  const hits: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body });
      res.statusCode = statuses[Math.min(hits.length - 1, statuses.length - 1)];
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { url, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("API keys", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  it("issues a hashed key shown once, scoped by permissions, usable only on public routes", async () => {
    const { owner, outlet } = await seedTenant();
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const created = await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "BI", permissions: ["orders.view"] });
    expect(created.status).toBe(201);
    const key: string = created.body.key;
    expect(key).toMatch(/^stk_[A-Za-z0-9]{8}_/);
    const row = await testPrisma.apiKey.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.keyHash).not.toContain(key.slice(13));
    expect((await http().get("/api/v1/integrations/api-keys").set(auth)).body[0].key).toBeUndefined();

    const k = { Authorization: `Bearer ${key}` };
    const orders = await http().get(`/api/v1/ext/orders?outletId=${outlet.id}`).set(k);
    expect(orders.status).toBe(200);
    expect(orders.body.items).toEqual([]);
    // Same key via X-Api-Key.
    expect((await http().get("/api/v1/ext/outlets").set("X-Api-Key", key)).status).toBe(200);
    // Out of scope.
    expect((await http().get(`/api/v1/ext/stock?outletId=${outlet.id}`).set(k)).status).toBe(403);
    // Internal (non-@ApiKeyAccess) routes refuse keys even when the scope would match.
    expect((await http().get("/api/v1/outlets").set(k)).status).toBe(403);
    expect((await http().get("/api/v1/integrations/api-keys").set(k)).status).toBe(403);

    expect((await testPrisma.apiKey.findUniqueOrThrow({ where: { id: row.id } })).lastUsedAt).not.toBeNull();

    // Revoked keys stop working.
    expect((await http().delete(`/api/v1/integrations/api-keys/${row.id}`).set(auth)).status).toBe(200);
    expect((await http().get("/api/v1/ext/outlets").set(k)).status).toBe(401);
    expect((await http().get("/api/v1/ext/outlets").set({ Authorization: "Bearer stk_nope_nope" })).status).toBe(401);
  });

  it("keys can't exceed their creator's permissions or hold *, and expire", async () => {
    const { addUser } = await seedTenant();
    const { user } = await addUser("int@t.test", ["integrations.manage", "orders.view"]);
    const auth = { Authorization: `Bearer ${await tokenFor(user)}` };
    expect((await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "x", permissions: ["reports.view"] })).status).toBe(403);
    expect((await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "x", permissions: ["*"] })).status).toBe(400);
    const ok = await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "x", permissions: ["orders.view"], expiresInDays: 1 });
    expect(ok.status).toBe(201);
    await testPrisma.apiKey.update({ where: { id: ok.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await http().get("/api/v1/ext/outlets").set({ Authorization: `Bearer ${ok.body.key}` })).status).toBe(401);
  });

  it("an outlet-restricted key can't read another outlet; keys are tenant-bound", async () => {
    const a = await seedTenant("Tenant A");
    const b = await seedTenant("Tenant B");
    const other = await testPrisma.outlet.create({ data: { tenantId: a.tenant.id, brandId: a.brand.id, name: "Second" } });
    const auth = { Authorization: `Bearer ${await tokenFor(a.owner)}` };
    const key = (await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "one", permissions: ["menu.stock", "orders.view"], outletIds: [a.outlet.id] })).body.key;
    const k = { Authorization: `Bearer ${key}` };
    expect((await http().get(`/api/v1/ext/items?outletId=${other.id}`).set(k)).status).toBe(403);
    expect((await http().get(`/api/v1/ext/items?outletId=${b.outlet.id}`).set(k)).status).toBe(403);
    expect((await http().get(`/api/v1/ext/items`).set(k)).status).toBe(200); // single outlet -> implicit
    // Foreign-tenant outlet ids can't be baked into a key.
    expect((await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "x", permissions: ["orders.view"], outletIds: [b.outlet.id] })).status).toBe(400);
  });
});

describe("webhooks", () => {
  let app: INestApplication;
  let hooks: WebhooksService;
  const closers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    app = await bootApp();
    hooks = app.get(WebhooksService);
  });
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  it("signature helper round-trips and rejects tampering / stale timestamps", () => {
    const now = 1_800_000_000;
    const sig = signWebhook("whsec_x", '{"a":1}', now);
    expect(verifyWebhookSignature("whsec_x", '{"a":1}', sig, 300, now)).toBe(true);
    expect(verifyWebhookSignature("whsec_x", '{"a":2}', sig, 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_y", '{"a":1}', sig, 300, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_x", '{"a":1}', sig, 300, now + 301)).toBe(false);
    expect(nextRetryDelay(1)).toBeGreaterThan(20_000);
    expect(nextRetryDelay(MAX_ATTEMPTS)).toBeNull();
  });

  it("domain event -> signed delivery to subscribed endpoints only (with order snapshot)", async () => {
    const { owner, outlet } = await seedTenant();
    const rx = await receiver([200]);
    closers.push(rx.close);
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const created = await http().post("/api/v1/integrations/webhooks").set(auth).send({ url: rx.url, events: ["order.settled", "stock.low"] });
    expect(created.status).toBe(201);
    const secret: string = created.body.secret;
    expect(secret).toMatch(/^whsec_/);

    const order = await testPrisma.order.create({ data: { tenantId: owner.tenantId, outletId: outlet.id, orderType: "TAKEAWAY", status: "SETTLED", total: 210, billNumber: "B-1" } });
    emitDomainEvent("order.created", owner.tenantId, outlet.id, { orderId: order.id }); // not subscribed
    emitDomainEvent("order.settled", owner.tenantId, outlet.id, { orderId: order.id });
    await domainEvents.idle();
    expect(await testPrisma.webhookDelivery.count()).toBe(1);

    expect(await hooks.processDue()).toBe(1);
    expect(rx.hits).toHaveLength(1);
    const hit = rx.hits[0];
    expect(hit.headers["stello-event"]).toBe("order.settled");
    expect(verifyWebhookSignature(secret, hit.body, String(hit.headers["stello-signature"]))).toBe(true);
    const body = JSON.parse(hit.body);
    expect(body.type).toBe("order.settled");
    expect(body.data.order).toMatchObject({ id: order.id, billNumber: "B-1", total: 210 });
    const d = await testPrisma.webhookDelivery.findFirstOrThrow();
    expect(d.status).toBe("SUCCEEDED");
    expect(d.attempts).toBe(1);
  });

  it("failed deliveries retry with backoff and end FAILED after the max attempts", async () => {
    const { owner, outlet } = await seedTenant();
    const rx = await receiver([500, 503, 200]);
    closers.push(rx.close);
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    await http().post("/api/v1/integrations/webhooks").set(auth).send({ url: rx.url, events: ["kot.status"] });
    emitDomainEvent("kot.status", owner.tenantId, outlet.id, { kotId: "k1", status: "READY" });
    await domainEvents.idle();

    await hooks.processDue();
    let d = await testPrisma.webhookDelivery.findFirstOrThrow();
    expect(d.status).toBe("PENDING");
    expect(d.attempts).toBe(1);
    expect(d.lastStatusCode).toBe(500);
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet -> nothing happens.
    expect(await hooks.processDue()).toBe(0);

    // Fast-forward: make it due twice more; third attempt succeeds.
    for (let i = 0; i < 2; i++) {
      await testPrisma.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await hooks.processDue();
    }
    d = await testPrisma.webhookDelivery.findFirstOrThrow();
    expect(d.status).toBe("SUCCEEDED");
    expect(d.attempts).toBe(3);
    expect(rx.hits).toHaveLength(3);

    // Always-failing receiver gives up after MAX_ATTEMPTS.
    await testPrisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "PENDING", attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    const down = await receiver([500]);
    closers.push(down.close);
    await testPrisma.webhookEndpoint.updateMany({ data: { url: down.url } });
    await hooks.processDue();
    d = await testPrisma.webhookDelivery.findFirstOrThrow();
    expect(d.status).toBe("FAILED");
    expect(d.nextAttemptAt).toBeNull();
  });

  it("test-send, delivery log, tenant isolation and low-stock events", async () => {
    const { owner, outlet } = await seedTenant("Hook A");
    const other = await seedTenant("Hook B");
    const rx = await receiver([204]);
    closers.push(rx.close);
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const ep = (await http().post("/api/v1/integrations/webhooks").set(auth).send({ url: rx.url, events: ["stock.low"] })).body;
    const test = await http().post(`/api/v1/integrations/webhooks/${ep.id}/test`).set(auth);
    expect(test.status).toBe(200);
    expect(test.body.status).toBe("SUCCEEDED");
    expect(test.body.eventType).toBe("webhook.test");
    const log = await http().get(`/api/v1/integrations/webhooks/${ep.id}/deliveries`).set(auth);
    expect(log.body.items).toHaveLength(1);

    const authB = { Authorization: `Bearer ${await tokenFor(other.owner)}` };
    expect((await http().get(`/api/v1/integrations/webhooks/${ep.id}/deliveries`).set(authB)).status).toBe(404);
    expect((await http().post(`/api/v1/integrations/webhooks/${ep.id}/test`).set(authB)).status).toBe(404);
    // Other tenant's events never reach this endpoint.
    emitDomainEvent("stock.low", other.tenant.id, other.outlet.id, { rawMaterialId: "x" });
    await domainEvents.idle();
    expect(await testPrisma.webhookDelivery.count({ where: { eventType: "stock.low" } })).toBe(0);

    // Crossing the reorder level emits stock.low once.
    await testPrisma.rawMaterial.create({ data: { tenantId: owner.tenantId, outletId: outlet.id, name: "Paneer", unit: "KG", stockQty: 1, reorderLevel: 2 } });
    emitDomainEvent("stock.changed", owner.tenantId, outlet.id, {});
    await domainEvents.idle();
    emitDomainEvent("stock.changed", owner.tenantId, outlet.id, {});
    await domainEvents.idle();
    const low = await testPrisma.webhookDelivery.findMany({ where: { eventType: "stock.low" } });
    expect(low).toHaveLength(1);
    expect((low[0].payload as { data: { name: string } }).data.name).toBe("Paneer");
  });

  it("rejects bad URLs and requires integrations.manage", async () => {
    const { owner, addUser } = await seedTenant();
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    expect((await http().post("/api/v1/integrations/webhooks").set(auth).send({ url: "ftp://x.test/a", events: ["order.created"] })).status).toBe(400);
    expect((await http().post("/api/v1/integrations/webhooks").set(auth).send({ url: "https://x.test/a", events: ["nope"] })).status).toBe(400);
    const { user } = await addUser("c@t.test", ["orders.create"]);
    expect((await http().get("/api/v1/integrations/webhooks").set({ Authorization: `Bearer ${await tokenFor(user)}` })).status).toBe(403);
  });
});

describe("MCP endpoint", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());
  const rpc = (key: string | null, body: object) => {
    const r = http().post("/api/v1/mcp").set("Accept", "application/json, text/event-stream").set("Content-Type", "application/json");
    if (key) r.set("Authorization", `Bearer ${key}`);
    return r.send(body);
  };

  async function keyWith(permissions: string[]) {
    const { owner, outlet } = await seedTenant(`Mcp ${permissions.join(" ")}`);
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const res = await http().post("/api/v1/integrations/api-keys").set(auth).send({ name: "mcp", permissions });
    return { key: res.body.key as string, owner, outlet, auth };
  }

  it("requires an API key (no key -> 401, user session -> 403)", async () => {
    expect((await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const { auth } = await keyWith(["orders.view"]);
    const res = await http().post("/api/v1/mcp").set(auth).set("Accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("initialize + tools/list are filtered by the key's permissions; tools run scoped", async () => {
    const { key, outlet, owner } = await keyWith(["orders.view", "menu.stock"]);
    const init = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("stello-kitchens");

    const list = await rpc(key, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["get_order", "list_items", "list_orders", "list_outlets", "set_item_availability"]);

    const cat = await testPrisma.menuCategory.create({ data: { tenantId: owner.tenantId, outletId: outlet.id, name: "Mains" } });
    const item = await testPrisma.item.create({ data: { tenantId: owner.tenantId, outletId: outlet.id, categoryId: cat.id, name: "Dal", price: 120 } });
    const call = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "set_item_availability", arguments: { itemId: item.id, inStock: false } },
    });
    expect(call.body.result.isError).toBeFalsy();
    expect((await testPrisma.item.findUniqueOrThrow({ where: { id: item.id } })).inStock).toBe(false);

    // A tool outside the key's scope isn't even registered.
    const denied = await rpc(key, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sales_summary", arguments: {} } });
    const failed = denied.body.error ?? (denied.body.result?.isError ? denied.body.result : null);
    expect(failed).toBeTruthy();

    // A foreign item id is not reachable.
    const other = await seedTenant("Mcp other");
    const cat2 = await testPrisma.menuCategory.create({ data: { tenantId: other.tenant.id, outletId: other.outlet.id, name: "X" } });
    const foreign = await testPrisma.item.create({ data: { tenantId: other.tenant.id, outletId: other.outlet.id, categoryId: cat2.id, name: "Y", price: 1 } });
    const cross = await rpc(key, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_item_availability", arguments: { itemId: foreign.id, inStock: false, outletId: other.outlet.id } } });
    expect(cross.body.result.isError).toBe(true);
    expect((await testPrisma.item.findUniqueOrThrow({ where: { id: foreign.id } })).inStock).toBe(true);
  });
});
