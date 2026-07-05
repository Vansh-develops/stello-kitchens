import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const publicToken = () => randomBytes(9).toString("base64url");

async function main() {
  const existing = await prisma.tenant.findFirst({ where: { name: "Demo Restaurants" } });
  if (existing) {
    console.log("Seed already applied, skipping.");
    return;
  }

  const tenant = await prisma.tenant.create({ data: { name: "Demo Restaurants" } });
  const brand = await prisma.brand.create({
    data: { tenantId: tenant.id, name: "Spice Route" },
  });

  const outlet1 = await prisma.outlet.create({
    data: {
      tenantId: tenant.id,
      brandId: brand.id,
      name: "Spice Route - Koramangala",
      address: "80 Feet Rd, Koramangala, Bengaluru",
      gstin: "29ABCDE1234F1Z5",
      upiVpa: "spiceroute.kor@okhdfc",
      placeOfSupply: "29",
      isCentralKitchen: true,
      publicToken: publicToken(),
    },
  });
  const outlet2 = await prisma.outlet.create({
    data: {
      tenantId: tenant.id,
      brandId: brand.id,
      name: "Spice Route - Indiranagar",
      address: "100 Feet Rd, Indiranagar, Bengaluru",
      gstin: "29ABCDE1234F2Z4",
      publicToken: publicToken(),
    },
  });

  const ownerRole = await prisma.role.create({
    data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] },
  });
  const cashierRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: "Cashier",
      permissions: ["orders.create", "orders.settle", "menu.stock"],
    },
  });
  const kitchenRole = await prisma.role.create({
    data: {
      tenantId: tenant.id,
      name: "Kitchen",
      // Can operate the KDS and 86 items, but not edit the menu (menu.manage).
      permissions: ["kds.operate", "menu.stock"],
    },
  });

  const passwordHash = await bcrypt.hash("password123", 10);
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "admin@demo.com",
      passwordHash,
      name: "Asha Owner",
      roleId: ownerRole.id,
      userOutlets: { create: [{ outletId: outlet1.id }, { outletId: outlet2.id }] },
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "cashier@demo.com",
      passwordHash,
      name: "Ravi Cashier",
      roleId: cashierRole.id,
      userOutlets: { create: [{ outletId: outlet1.id }] },
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "kitchen@demo.com",
      passwordHash,
      name: "Kitchen Display",
      roleId: kitchenRole.id,
      userOutlets: { create: [{ outletId: outlet1.id }] },
    },
  });

  // Device fleet: a POS counter, a KDS screen, and a receipt printer.
  await prisma.terminal.create({
    data: { tenantId: tenant.id, outletId: outlet1.id, name: "Counter 1", type: "POS", config: {} },
  });
  await prisma.terminal.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      name: "Kitchen Screen",
      type: "KDS",
      config: { theme: "dark", density: "comfortable", sound: true, columns: 3 },
    },
  });
  await prisma.terminal.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      name: "Counter Printer",
      type: "PRINTER",
      config: { paperWidth: "80mm", autoPrintKot: true, autoPrintBill: true, copies: 1 },
    },
  });

  // Floor plan for outlet 1
  const groundFloor = await prisma.area.create({
    data: { tenantId: tenant.id, outletId: outlet1.id, name: "Ground Floor" },
  });
  const rooftop = await prisma.area.create({
    data: { tenantId: tenant.id, outletId: outlet1.id, name: "Rooftop" },
  });
  for (let i = 1; i <= 8; i++) {
    await prisma.diningTable.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        areaId: groundFloor.id,
        name: `T${i}`,
        seats: i <= 4 ? 4 : 6,
        publicToken: publicToken(),
      },
    });
  }
  for (let i = 1; i <= 4; i++) {
    await prisma.diningTable.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        areaId: rooftop.id,
        name: `R${i}`,
        seats: 4,
        publicToken: publicToken(),
      },
    });
  }

  // Addon groups
  const toppings = await prisma.addonGroup.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      name: "Extra Toppings",
      minSelect: 0,
      maxSelect: 3,
      addons: {
        create: [
          { name: "Extra Cheese", price: 40 },
          { name: "Extra Butter", price: 20 },
          { name: "Extra Gravy", price: 35 },
        ],
      },
    },
  });
  const breadExtras = await prisma.addonGroup.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      name: "Bread Extras",
      minSelect: 0,
      maxSelect: 2,
      addons: {
        create: [
          { name: "Butter", price: 10 },
          { name: "Garlic", price: 15 },
        ],
      },
    },
  });

  // Kitchen stations + their target prep times (drive KDS ageing colours)
  const stationDefs = [
    { key: "tandoor", name: "Tandoor", prepMinutes: 12 },
    { key: "main", name: "Main Kitchen", prepMinutes: 15 },
    { key: "beverages", name: "Beverages", prepMinutes: 4 },
    { key: "desserts", name: "Desserts", prepMinutes: 5 },
  ];
  const stations: Record<string, string> = {};
  let stationOrder = 0;
  for (const s of stationDefs) {
    const created = await prisma.station.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        name: s.name,
        prepMinutes: s.prepMinutes,
        sortOrder: stationOrder++,
      },
    });
    stations[s.key] = created.id;
  }

  const categoryStation: Record<string, string> = {
    Starters: stations.tandoor,
    "Main Course": stations.main,
    Breads: stations.tandoor,
    Beverages: stations.beverages,
    Desserts: stations.desserts,
  };

  // Sales channels — Dine-in is direct; Zomato/Swiggy carry per-channel pricing.
  const channelDefs = [
    { name: "Dine-in", kind: "DIRECT" },
    { name: "Zomato", kind: "AGGREGATOR" },
    { name: "Swiggy", kind: "AGGREGATOR" },
  ];
  let channelOrder = 0;
  for (const c of channelDefs) {
    await prisma.channel.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        name: c.name,
        kind: c.kind,
        sortOrder: channelOrder++,
      },
    });
  }

  const menu: {
    category: string;
    items: {
      name: string;
      code: string;
      price: number;
      veg?: boolean;
      variations?: { name: string; price: number }[];
      addonGroupIds?: string[];
    }[];
  }[] = [
    {
      category: "Starters",
      items: [
        {
          name: "Paneer Tikka",
          code: "PT",
          price: 260,
          variations: [
            { name: "Half", price: 160 },
            { name: "Full", price: 260 },
          ],
          addonGroupIds: [toppings.id],
        },
        { name: "Veg Spring Roll", code: "VSR", price: 180 },
        { name: "Chicken 65", code: "C65", price: 290, veg: false },
        {
          name: "Tandoori Chicken",
          code: "TC",
          price: 420,
          veg: false,
          variations: [
            { name: "Half", price: 260 },
            { name: "Full", price: 420 },
          ],
        },
      ],
    },
    {
      category: "Main Course",
      items: [
        { name: "Paneer Butter Masala", code: "PBM", price: 280, addonGroupIds: [toppings.id] },
        { name: "Dal Makhani", code: "DM", price: 240, addonGroupIds: [toppings.id] },
        { name: "Butter Chicken", code: "BC", price: 340, veg: false, addonGroupIds: [toppings.id] },
        { name: "Veg Biryani", code: "VB", price: 250 },
        { name: "Chicken Biryani", code: "CB", price: 320, veg: false },
      ],
    },
    {
      category: "Breads",
      items: [
        { name: "Tandoori Roti", code: "TR", price: 35, addonGroupIds: [breadExtras.id] },
        { name: "Butter Naan", code: "BN", price: 55, addonGroupIds: [breadExtras.id] },
        { name: "Garlic Naan", code: "GN", price: 70 },
        { name: "Laccha Paratha", code: "LP", price: 60 },
      ],
    },
    {
      category: "Beverages",
      items: [
        { name: "Masala Chaas", code: "MC", price: 60 },
        { name: "Sweet Lassi", code: "SL", price: 90 },
        { name: "Fresh Lime Soda", code: "FLS", price: 80 },
        { name: "Soft Drink", code: "SD", price: 50 },
      ],
    },
    {
      category: "Desserts",
      items: [
        { name: "Gulab Jamun", code: "GJ", price: 90 },
        { name: "Rasmalai", code: "RM", price: 120 },
        { name: "Brownie with Ice Cream", code: "BIC", price: 180 },
      ],
    },
  ];

  let sortOrder = 0;
  const itemByName = new Map<string, string>();
  const categoryByName = new Map<string, string>();
  for (const cat of menu) {
    const category = await prisma.menuCategory.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        name: cat.category,
        stationId: categoryStation[cat.category] ?? null,
        sortOrder: sortOrder++,
      },
    });
    categoryByName.set(cat.category, category.id);
    for (const item of cat.items) {
      const created = await prisma.item.create({
        data: {
          tenantId: tenant.id,
          outletId: outlet1.id,
          categoryId: category.id,
          name: item.name,
          shortCode: item.code,
          price: item.price,
          isVeg: item.veg ?? true,
          taxRate: 5,
          variations: item.variations ? { create: item.variations } : undefined,
          addonGroups: item.addonGroupIds
            ? { create: item.addonGroupIds.map((id) => ({ addonGroupId: id })) }
            : undefined,
        },
      });
      itemByName.set(item.name, created.id);
    }
  }

  // ---------- Combos (bundled meals) ----------
  const opt = (name: string, extra?: { priceDelta?: number; isDefault?: boolean }) => ({
    itemId: itemByName.get(name)!,
    priceDelta: extra?.priceDelta ?? 0,
    isDefault: extra?.isDefault ?? false,
  });
  await prisma.combo.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      categoryId: categoryByName.get("Main Course")!,
      name: "Chicken Lover's Meal",
      price: 499,
      isVeg: false,
      taxRate: 5,
      slots: {
        create: [
          {
            name: "Main",
            sortOrder: 0,
            options: {
              create: [opt("Chicken Biryani", { isDefault: true }), opt("Butter Chicken", { priceDelta: 20 })],
            },
          },
          {
            name: "Drink",
            sortOrder: 1,
            options: { create: [opt("Soft Drink", { isDefault: true }), opt("Sweet Lassi", { priceDelta: 30 })] },
          },
          {
            name: "Dessert",
            sortOrder: 2,
            options: { create: [opt("Gulab Jamun", { isDefault: true }), opt("Rasmalai", { priceDelta: 20 })] },
          },
        ],
      },
    },
  });
  await prisma.combo.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      categoryId: categoryByName.get("Main Course")!,
      name: "Veg Thali Combo",
      price: 399,
      isVeg: true,
      taxRate: 5,
      slots: {
        create: [
          {
            name: "Sabzi",
            sortOrder: 0,
            options: { create: [opt("Paneer Butter Masala", { isDefault: true }), opt("Dal Makhani")] },
          },
          {
            name: "Bread",
            sortOrder: 1,
            options: { create: [opt("Butter Naan", { isDefault: true }), opt("Garlic Naan", { priceDelta: 10 })] },
          },
          {
            name: "Dessert",
            sortOrder: 2,
            options: { create: [opt("Gulab Jamun", { isDefault: true }), opt("Rasmalai", { priceDelta: 20 })] },
          },
        ],
      },
    },
  });

  // ---------- Inventory: raw materials + recipes ----------
  const materialDefs = [
    { key: "chicken", name: "Chicken", unit: "KG", stock: 20, reorder: 5, cost: 240 },
    { key: "paneer", name: "Paneer", unit: "KG", stock: 10, reorder: 3, cost: 320 },
    { key: "onion", name: "Onion", unit: "KG", stock: 30, reorder: 8, cost: 40 },
    { key: "tomato", name: "Tomato", unit: "KG", stock: 25, reorder: 8, cost: 50 },
    { key: "butter", name: "Butter", unit: "KG", stock: 8, reorder: 2, cost: 500 },
    { key: "cream", name: "Fresh Cream", unit: "L", stock: 1.8, reorder: 2, cost: 220 }, // seeded low
    { key: "rice", name: "Basmati Rice", unit: "KG", stock: 40, reorder: 10, cost: 120 },
    { key: "oil", name: "Refined Oil", unit: "L", stock: 15, reorder: 5, cost: 140 },
    { key: "flour", name: "Wheat Flour", unit: "KG", stock: 25, reorder: 8, cost: 45 },
    { key: "dal", name: "Black Dal", unit: "KG", stock: 12, reorder: 3, cost: 130 },
    { key: "spice", name: "Spice Mix", unit: "KG", stock: 5, reorder: 1, cost: 600 },
  ];
  const materials: Record<string, string> = {};
  for (const m of materialDefs) {
    const created = await prisma.rawMaterial.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        name: m.name,
        unit: m.unit,
        stockQty: m.stock,
        reorderLevel: m.reorder,
        costPerUnit: m.cost,
      },
    });
    materials[m.key] = created.id;
  }

  const recipes: Record<string, [string, number][]> = {
    // Butter Chicken uses a semi-finished "Makhani Gravy Base" (added below) instead of
    // listing onion/tomato/butter/cream directly — a multi-stage recipe.
    "Butter Chicken": [["chicken", 0.25], ["spice", 0.01]],
    "Paneer Butter Masala": [["paneer", 0.2], ["butter", 0.03], ["cream", 0.05], ["tomato", 0.1], ["onion", 0.05], ["spice", 0.01]],
    "Dal Makhani": [["dal", 0.1], ["butter", 0.02], ["cream", 0.04], ["tomato", 0.05], ["onion", 0.03]],
    "Chicken Biryani": [["chicken", 0.2], ["rice", 0.15], ["onion", 0.05], ["oil", 0.03], ["spice", 0.015]],
    "Veg Biryani": [["rice", 0.15], ["onion", 0.05], ["tomato", 0.05], ["oil", 0.03], ["spice", 0.01]],
    "Paneer Tikka": [["paneer", 0.18], ["onion", 0.03], ["spice", 0.01]],
    "Chicken 65": [["chicken", 0.2], ["oil", 0.02], ["spice", 0.012]],
    "Butter Naan": [["flour", 0.1], ["butter", 0.01]],
    "Tandoori Roti": [["flour", 0.08]],
  };
  for (const [itemName, lines] of Object.entries(recipes)) {
    const item = await prisma.item.findFirst({ where: { outletId: outlet1.id, name: itemName } });
    if (!item) continue;
    for (const [matKey, qty] of lines) {
      await prisma.recipeIngredient.create({
        data: { itemId: item.id, rawMaterialId: materials[matKey], quantity: qty },
      });
    }
  }

  // Semi-finished good: Makhani Gravy Base, produced in-house from a prep recipe.
  const gravyBase = await prisma.rawMaterial.create({
    data: {
      tenantId: tenant.id,
      outletId: outlet1.id,
      name: "Makhani Gravy Base",
      unit: "L",
      stockQty: 0,
      reorderLevel: 2,
      costPerUnit: 0,
      isSemiFinished: true,
    },
  });
  const prep: [string, number][] = [
    ["onion", 0.3],
    ["tomato", 0.4],
    ["butter", 0.05],
    ["cream", 0.1],
    ["spice", 0.02],
  ];
  for (const [matKey, qty] of prep) {
    await prisma.prepRecipeIngredient.create({
      data: { outputMaterialId: gravyBase.id, inputMaterialId: materials[matKey], quantity: qty },
    });
  }
  // Butter Chicken consumes the gravy base (0.15 L per plate).
  const butterChicken = await prisma.item.findFirst({
    where: { outletId: outlet1.id, name: "Butter Chicken" },
  });
  if (butterChicken) {
    await prisma.recipeIngredient.create({
      data: { itemId: butterChicken.id, rawMaterialId: gravyBase.id, quantity: 0.15 },
    });
  }

  // ---------- CRM: coupons + demo customers ----------
  const couponDefs = [
    { code: "WELCOME50", type: "FLAT", value: 50, minOrder: 300 },
    { code: "SAVE20", type: "PERCENT", value: 20, minOrder: 500, maxDiscount: 150 },
    { code: "FLAT100", type: "FLAT", value: 100, minOrder: 800, usageLimit: 100 },
  ];
  for (const c of couponDefs) {
    await prisma.coupon.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        code: c.code,
        type: c.type,
        value: c.value,
        minOrder: c.minOrder,
        maxDiscount: c.maxDiscount ?? null,
        usageLimit: c.usageLimit ?? null,
      },
    });
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const customerDefs = [
    { name: "Ishan Mehta", phone: "9810011111", points: 240, orders: 12, spent: 8600, visit: daysAgo(2) },
    { name: "Priya Rao", phone: "9820022222", points: 60, orders: 4, spent: 2200, visit: daysAgo(6) },
    { name: "Arjun Nair", phone: "9830033333", points: 15, orders: 1, spent: 480, visit: daysAgo(1) },
    { name: "Sara Khan", phone: "9840044444", points: 120, orders: 8, spent: 5200, visit: daysAgo(75) },
  ];
  for (const c of customerDefs) {
    const created = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        outletId: outlet1.id,
        name: c.name,
        phone: c.phone,
        loyaltyPoints: c.points,
        totalOrders: c.orders,
        totalSpent: c.spent,
        lastVisitAt: c.visit,
      },
    });
    await prisma.loyaltyTransaction.create({
      data: { customerId: created.id, type: "ADJUST", points: c.points, note: "Opening balance" },
    });
  }

  console.log(`  materials: ${materialDefs.length} raw materials, ${Object.keys(recipes).length} recipes`);
  console.log(`  crm: ${couponDefs.length} coupons, ${customerDefs.length} customers`);
  console.log("Seeded demo tenant:");
  console.log(`  tenant: ${tenant.name}`);
  console.log(`  outlets: ${outlet1.name}, ${outlet2.name}`);
  console.log(`  stations: ${stationDefs.map((s) => s.name).join(", ")}`);
  console.log(`  channels: ${channelDefs.map((c) => c.name).join(", ")}`);
  console.log(`  users: admin@demo.com (Owner), cashier@demo.com (Cashier), kitchen@demo.com (Kitchen) — all password123`);
  console.log(`  admin id: ${admin.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
