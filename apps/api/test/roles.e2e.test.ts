import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { testPrisma } from "./db";
import { bootApp, seedTenant } from "./platform-helpers";

/** Bearer token for a seeded user without going through the throttled login route. */
const jwt = new JwtService({ secret: "dev-secret-change-me" });
const tokenFor = (u: { id: string; tenantId: string }) => jwt.signAsync({ sub: u.id, tenantId: u.tenantId, tokenVersion: 0 });

describe("role editor guards", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  it("owner can create, edit and delete a custom role; staff list shows assignments", async () => {
    const { owner } = await seedTenant();
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const created = await http().post("/api/v1/roles").set(auth).send({ name: "Shift lead", permissions: ["orders.create", "orders.settle", "loyalty.tiers"] });
    expect(created.status).toBe(201);
    expect(created.body.permissions).toContain("loyalty.tiers"); // uncatalogued keys from other modules are allowed

    const dup = await http().post("/api/v1/roles").set(auth).send({ name: "Shift lead", permissions: [] });
    expect(dup.status).toBe(409);
    const bad = await http().post("/api/v1/roles").set(auth).send({ name: "X", permissions: ["DROP TABLE"] });
    expect(bad.status).toBe(400);

    const edited = await http().patch(`/api/v1/roles/${created.body.id}`).set(auth).send({ name: "Shift lead", permissions: ["orders.create"] });
    expect(edited.body.permissions).toEqual(["orders.create"]);
    const del = await http().delete(`/api/v1/roles/${created.body.id}`).set(auth);
    expect(del.status).toBe(200);

    const staff = await http().get("/api/v1/staff").set(auth);
    expect(staff.body.map((s: { email: string }) => s.email)).toContain(owner.email);
    expect(await testPrisma.auditLog.count({ where: { action: { in: ["ROLE_CREATED", "ROLE_UPDATED", "ROLE_DELETED"] } } })).toBe(3);
  });

  it("a manager can't grant, edit into, or assign beyond their own permissions", async () => {
    const { owner, ownerRole, addUser } = await seedTenant();
    const { user: manager } = await addUser("mgr@t.test", ["roles.manage", "orders.create", "orders.settle"], "Manager");
    const { user: cashier, role: cashierRole } = await addUser("cash@t.test", ["orders.create"], "Cashier");
    const auth = { Authorization: `Bearer ${await tokenFor(manager)}` };

    expect((await http().post("/api/v1/roles").set(auth).send({ name: "Sneaky", permissions: ["orders.create", "reports.view"] })).status).toBe(403);
    expect((await http().post("/api/v1/roles").set(auth).send({ name: "Sneaky", permissions: ["*"] })).status).toBe(403);
    const ok = await http().post("/api/v1/roles").set(auth).send({ name: "Till", permissions: ["orders.create", "orders.settle"] });
    expect(ok.status).toBe(201);

    // Can't widen an existing role past their own access, nor touch the owner role.
    expect((await http().patch(`/api/v1/roles/${cashierRole.id}`).set(auth).send({ name: "Cashier", permissions: ["finance.manage"] })).status).toBe(403);
    expect((await http().patch(`/api/v1/roles/${ownerRole.id}`).set(auth).send({ name: "Owner", permissions: ["orders.create"] })).status).toBe(403);
    expect((await http().delete(`/api/v1/roles/${ownerRole.id}`).set(auth)).status).toBe(403);

    // Can't promote anyone (or themselves) to Owner, nor demote the owner.
    expect((await http().patch(`/api/v1/staff/${cashier.id}/role`).set(auth).send({ roleId: ownerRole.id })).status).toBe(403);
    expect((await http().patch(`/api/v1/staff/${manager.id}/role`).set(auth).send({ roleId: ownerRole.id })).status).toBe(403);
    expect((await http().patch(`/api/v1/staff/${owner.id}/role`).set(auth).send({ roleId: cashierRole.id })).status).toBe(403);

    // Within their access it works.
    const moved = await http().patch(`/api/v1/staff/${cashier.id}/role`).set(auth).send({ roleId: ok.body.id });
    expect(moved.status).toBe(200);
    expect(moved.body.roleName).toBe("Till");

    // And invites can't escalate either.
    expect((await http().post("/api/v1/tenant/invites").set(auth).send({ email: "x@t.test", roleId: ownerRole.id })).status).toBe(403);
  });

  it("the last owner can't be demoted and the owner role can't lose * while it is the only one", async () => {
    const { owner, ownerRole, addUser } = await seedTenant();
    const { role: cashierRole } = await addUser("c@t.test", ["orders.create"]);
    const auth = { Authorization: `Bearer ${await tokenFor(owner)}` };
    expect((await http().patch(`/api/v1/staff/${owner.id}/role`).set(auth).send({ roleId: cashierRole.id })).status).toBe(400);
    expect((await http().patch(`/api/v1/roles/${ownerRole.id}`).set(auth).send({ name: "Owner", permissions: ["roles.manage"] })).status).toBe(400);
    // Deleting a role with people on it is refused.
    expect((await http().delete(`/api/v1/roles/${ownerRole.id}`).set(auth)).status).toBe(409);

    // With a second owner the first may step down.
    const { user: second } = await addUser("o2@t.test", ["*"], "Co-owner");
    expect(second.id).toBeTruthy();
    expect((await http().patch(`/api/v1/staff/${owner.id}/role`).set(auth).send({ roleId: cashierRole.id })).status).toBe(200);
  });

  it("concurrent demotions of the two remaining owners leave at least one owner", async () => {
    const { owner, addUser } = await seedTenant();
    const { user: second } = await addUser("o2@t.test", ["*"], "Co-owner");
    const { role: cashierRole } = await addUser("c@t.test", ["orders.create"]);
    const a = { Authorization: `Bearer ${await tokenFor(owner)}` };
    const b = { Authorization: `Bearer ${await tokenFor(second)}` };
    const [r1, r2] = await Promise.all([
      http().patch(`/api/v1/staff/${second.id}/role`).set(a).send({ roleId: cashierRole.id }),
      http().patch(`/api/v1/staff/${owner.id}/role`).set(b).send({ roleId: cashierRole.id }),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    const owners = await testPrisma.user.findMany({ where: { tenantId: owner.tenantId }, include: { role: true } });
    expect(owners.filter((u) => (u.role.permissions as string[]).includes("*")).length).toBeGreaterThanOrEqual(1);
  });

  it("roles are tenant-isolated and gated by roles.manage", async () => {
    const a = await seedTenant("Tenant A");
    const b = await seedTenant("Tenant B");
    const authA = { Authorization: `Bearer ${await tokenFor(a.owner)}` };
    expect((await http().patch(`/api/v1/roles/${b.ownerRole.id}`).set(authA).send({ name: "x", permissions: [] })).status).toBe(404);
    expect((await http().patch(`/api/v1/staff/${b.owner.id}/role`).set(authA).send({ roleId: a.ownerRole.id })).status).toBe(404);
    const { user: cashier } = await a.addUser("c@a.test", ["orders.create"]);
    expect((await http().get("/api/v1/roles").set({ Authorization: `Bearer ${await tokenFor(cashier)}` })).status).toBe(403);
  });
});
