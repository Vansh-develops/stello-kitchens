import { describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChainService } from "../src/chain/chain.service";
import { resolveMasterItem } from "../src/chain/menu-sync";
import { testPrisma } from "./db";

const realtime = { notifyOutlet: () => {} } as any;
const svc = () => new ChainService(new PrismaService(), realtime);

async function setup() {
  const tenant = await testPrisma.tenant.create({ data: { name: "Chain Co" } });
  const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: "Biryani Bros" } });
  const a = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Koramangala" } });
  const b = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Indiranagar" } });
  const user = {
    id: "u1", tenantId: tenant.id, email: "x@y.z", name: "Brand Admin", roleName: "Owner",
    permissions: ["*"], outletIds: [a.id, b.id], isPlatformAdmin: false,
  } as any;
  return { tenant, brand, a, b, user };
}

async function seedMaster(s: ChainService, user: any, brandId: string) {
  const cat = await s.createCategory(user, brandId, { name: "Biryani", sortOrder: 1 });
  const raita = await s.createAddonGroup(user, brandId, {
    name: "Sides", minSelect: 0, maxSelect: 2, addons: [{ name: "Raita", price: 30 }],
  });
  const veg = await s.createItem(user, brandId, {
    categoryId: cat.id, name: "Veg Biryani", price: 220, isVeg: true, taxRate: 5,
    variations: [{ name: "Half", price: 150 }, { name: "Full", price: 220 }],
    addonGroupIds: [raita.id], nameTranslations: { hi: "वेज बिरयानी" },
  });
  const chicken = await s.createItem(user, brandId, {
    categoryId: cat.id, name: "Chicken Biryani", price: 280, isVeg: false, taxRate: 5,
    variations: [], addonGroupIds: [],
  });
  const combo = await s.createCombo(user, brandId, {
    categoryId: cat.id, name: "Biryani Meal", price: 299, isVeg: false, taxRate: 5,
    slots: [{ name: "Main", options: [{ masterItemId: chicken.id, priceDelta: 0, isDefault: true }] }],
  });
  return { cat, raita, veg, chicken, combo };
}

describe("override resolution", () => {
  const master = {
    id: "m", name: "Dal", shortCode: null, price: 200, isVeg: true, taxRate: 5, hsnCode: "996331",
    sortOrder: 0, availableStart: null, availableEnd: null, nameTranslations: { hi: "दाल", ta: " " },
  };

  it("inherits everything without an override", () => {
    const r = resolveMasterItem(master, null);
    expect(r.price).toBe(200);
    expect(r.hidden).toBe(false);
    expect(r.inStock).toBeNull();
    expect(r.nameTranslations).toEqual({ hi: "दाल" }); // blank translations dropped
  });

  it("override fields win; null fields inherit", () => {
    expect(resolveMasterItem(master, { price: 180, inStock: null, isHidden: false }).price).toBe(180);
    const r = resolveMasterItem(master, { price: null, inStock: false, isHidden: true });
    expect(r.price).toBe(200);
    expect(r.inStock).toBe(false);
    expect(r.hidden).toBe(true);
  });
});

describe("brand master menu publish", () => {
  it("previews then publishes the master to outlets with linked rows", async () => {
    const { brand, a, b, user } = await setup();
    const s = svc();
    const m = await seedMaster(s, user, brand.id);

    const preview = await s.preview(user, brand.id, [a.id]);
    expect(preview.outlets[0].counts.CREATE).toBe(5); // group + category + 2 items + combo
    expect(await testPrisma.item.count({ where: { outletId: a.id } })).toBe(0); // preview writes nothing

    await s.publish(user, brand.id, [a.id, b.id]);
    const items = await testPrisma.item.findMany({
      where: { outletId: a.id }, include: { variations: true, addonGroups: true },
    });
    const veg = items.find((i) => i.masterItemId === m.veg.id)!;
    expect(Number(veg.price)).toBe(220);
    expect(veg.variations).toHaveLength(2);
    expect(veg.addonGroups).toHaveLength(1);
    expect(veg.nameTranslations).toEqual({ hi: "वेज बिरयानी" });
    const combo = await testPrisma.combo.findFirst({ where: { outletId: a.id }, include: { slots: { include: { options: true } } } });
    expect(combo?.masterComboId).toBe(m.combo.id);
    expect(combo?.slots[0].options[0].itemId).toBe(items.find((i) => i.masterItemId === m.chicken.id)!.id);

    const menu = await s.masterMenu(user, brand.id);
    expect(menu.outlets.every((o) => o.status === "IN_SYNC")).toBe(true);

    // A second publish with no master change is a no-op.
    const again = await s.preview(user, brand.id, [a.id]);
    expect(again.outlets[0].counts.UNCHANGED).toBe(5);
  });

  it("keeps outlet overrides when the master price changes and flags them", async () => {
    const { brand, a, b, user } = await setup();
    const s = svc();
    const m = await seedMaster(s, user, brand.id);
    await s.publish(user, brand.id, [a.id, b.id]);

    // Outlet B overrides the price; applied immediately without a publish.
    await s.setOverride(user, b.id, m.veg.id, { price: 199, inStock: null, isHidden: false });
    const bVeg = await testPrisma.item.findFirst({ where: { outletId: b.id, masterItemId: m.veg.id } });
    expect(Number(bVeg!.price)).toBe(199);

    await s.updateItem(user, brand.id, m.veg.id, { price: 240 });
    expect((await s.masterMenu(user, brand.id)).outlets.every((o) => o.status === "PENDING")).toBe(true);

    const plan = await s.preview(user, brand.id, [a.id, b.id]);
    const opA = plan.outlets.find((o) => o.outletId === a.id)!.ops.find((o) => o.masterId === m.veg.id)!;
    const opB = plan.outlets.find((o) => o.outletId === b.id)!.ops.find((o) => o.masterId === m.veg.id)!;
    expect(opA.action).toBe("UPDATE");
    expect(opA.changes).toContainEqual({ field: "price", from: 220, to: 240 });
    expect(opB.action).toBe("UNCHANGED"); // override absorbs the master change

    await s.publish(user, brand.id, [a.id, b.id]);
    const after = await testPrisma.item.findMany({ where: { masterItemId: m.veg.id } });
    expect(after.map((i) => [i.outletId, Number(i.price)]).sort()).toEqual([[a.id, 240], [b.id, 199]].sort());
    expect(after.every((i) => i.masterVersion === 2)).toBe(true);

    // Clearing the override restores the master price.
    await s.setOverride(user, b.id, m.veg.id, { price: null, inStock: null, isHidden: false });
    expect(Number((await testPrisma.item.findFirst({ where: { outletId: b.id, masterItemId: m.veg.id } }))!.price)).toBe(240);
  });

  it("hides items per outlet and withdraws combos left without options", async () => {
    const { brand, a, user } = await setup();
    const s = svc();
    const m = await seedMaster(s, user, brand.id);
    await s.publish(user, brand.id, [a.id]);

    await s.setOverride(user, a.id, m.chicken.id, { price: null, inStock: null, isHidden: true });
    const plan = await s.preview(user, brand.id, [a.id]);
    const comboOp = plan.outlets[0].ops.find((o) => o.entity === "COMBO")!;
    expect(comboOp.action).toBe("REMOVE");
    expect(comboOp.conflict?.rule).toBe("COMBO_UNAVAILABLE");

    await s.publish(user, brand.id, [a.id]);
    const chicken = await testPrisma.item.findFirst({ where: { outletId: a.id, masterItemId: m.chicken.id } });
    expect(chicken?.deletedAt).not.toBeNull();
    expect((await testPrisma.combo.findFirst({ where: { outletId: a.id } }))?.deletedAt).not.toBeNull();
  });

  it("resets local edits to master-owned fields and reports the conflict", async () => {
    const { brand, a, user } = await setup();
    const s = svc();
    const m = await seedMaster(s, user, brand.id);
    await s.publish(user, brand.id, [a.id]);
    const row = await testPrisma.item.findFirst({ where: { outletId: a.id, masterItemId: m.chicken.id } });
    await testPrisma.item.update({ where: { id: row!.id }, data: { name: "Chikken Biriyani", inStock: false } });

    const op = (await s.preview(user, brand.id, [a.id])).outlets[0].ops.find((o) => o.masterId === m.chicken.id)!;
    expect(op.conflict?.rule).toBe("LOCAL_EDIT_OVERWRITTEN");
    await s.publish(user, brand.id, [a.id]);
    const after = await testPrisma.item.findUnique({ where: { id: row!.id } });
    expect(after?.name).toBe("Chicken Biryani");
    expect(after?.inStock).toBe(false); // the outlet's 86 toggle is operational state, not overwritten
  });

  it("adopts same-named outlet rows, never touches outlet-only items, detaches categories that still hold them", async () => {
    const { tenant, brand, a, user } = await setup();
    const s = svc();
    const cat = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: a.id, name: "biryani" } });
    const legacy = await testPrisma.item.create({
      data: { tenantId: tenant.id, outletId: a.id, categoryId: cat.id, name: "Veg Biryani", price: 199 },
    });
    const local = await testPrisma.item.create({
      data: { tenantId: tenant.id, outletId: a.id, categoryId: cat.id, name: "Outlet Special", price: 99 },
    });
    const m = await seedMaster(s, user, brand.id);

    const plan = await s.preview(user, brand.id, [a.id]);
    expect(plan.outlets[0].ops.find((o) => o.masterId === m.veg.id)?.action).toBe("LINK");
    await s.publish(user, brand.id, [a.id]);

    const linked = await testPrisma.item.findUnique({ where: { id: legacy.id } });
    expect(linked?.masterItemId).toBe(m.veg.id);
    expect(Number(linked?.price)).toBe(220);
    expect(await testPrisma.item.count({ where: { outletId: a.id, name: "Veg Biryani" } })).toBe(1);
    const untouched = await testPrisma.item.findUnique({ where: { id: local.id } });
    expect(untouched?.masterItemId).toBeNull();
    expect(Number(untouched?.price)).toBe(99);

    await s.deleteCategory(user, brand.id, m.cat.id);
    const removal = await s.preview(user, brand.id, [a.id]);
    expect(removal.outlets[0].ops.find((o) => o.entity === "CATEGORY")).toMatchObject({
      action: "DETACH", conflict: { rule: "OUTLET_ITEMS_KEPT" },
    });
    await s.publish(user, brand.id, [a.id]);
    const keptCat = await testPrisma.menuCategory.findUnique({ where: { id: cat.id } });
    expect(keptCat?.deletedAt).toBeNull();
    expect(keptCat?.masterCategoryId).toBeNull();
    expect((await testPrisma.item.findUnique({ where: { id: legacy.id } }))?.deletedAt).not.toBeNull();
    expect((await testPrisma.item.findUnique({ where: { id: local.id } }))?.deletedAt).toBeNull();
  });

  it("imports an existing outlet menu as the master and marks that outlet in sync", async () => {
    const { tenant, brand, a, b, user } = await setup();
    const s = svc();
    const cat = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: a.id, name: "Starters" } });
    await testPrisma.item.create({
      data: {
        tenantId: tenant.id, outletId: a.id, categoryId: cat.id, name: "Paneer Tikka", price: 260,
        variations: { create: [{ name: "6 pc", price: 260 }] },
      },
    });
    const res = await s.importFromOutlet(user, brand.id, a.id);
    expect(res).toMatchObject({ categories: 1, items: 1 });
    const menu = await s.masterMenu(user, brand.id);
    expect(menu.categories[0].items[0]).toMatchObject({ name: "Paneer Tikka", price: 260, variations: [{ name: "6 pc", price: 260 }] });
    expect(menu.outlets.find((o) => o.outletId === a.id)?.status).toBe("IN_SYNC");
    expect(menu.outlets.find((o) => o.outletId === b.id)?.status).toBe("NEVER");
    expect((await s.preview(user, brand.id, [a.id])).outlets[0].counts.UNCHANGED).toBe(2);
    await expect(s.importFromOutlet(user, brand.id, a.id)).rejects.toThrow(/empty master/);
  });

  it("is tenant-scoped", async () => {
    const { brand, user } = await setup();
    const other = await testPrisma.tenant.create({ data: { name: "Other" } });
    const intruder = { ...user, tenantId: other.id, outletIds: [] };
    await expect(svc().masterMenu(intruder, brand.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
