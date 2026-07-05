// Idempotently add the Makhani Gravy Base semi-finished good to the seeded
// Koramangala outlet and repoint Butter Chicken to consume it (a multi-stage recipe).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
const mats = await prisma.rawMaterial.findMany({ where: { outletId: outlet.id, deletedAt: null } });
const byName = new Map(mats.map((m) => [m.name, m]));

let base = byName.get("Makhani Gravy Base");
if (!base) {
  base = await prisma.rawMaterial.create({
    data: {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      name: "Makhani Gravy Base",
      unit: "L",
      stockQty: 0,
      reorderLevel: 2,
      costPerUnit: 0,
      isSemiFinished: true,
    },
  });
  const prep = [
    ["Onion", 0.3],
    ["Tomato", 0.4],
    ["Butter", 0.05],
    ["Fresh Cream", 0.1],
    ["Spice Mix", 0.02],
  ];
  for (const [name, qty] of prep) {
    const input = byName.get(name);
    if (input) {
      await prisma.prepRecipeIngredient.create({
        data: { outputMaterialId: base.id, inputMaterialId: input.id, quantity: qty },
      });
    }
  }
  console.log("Created Makhani Gravy Base + prep recipe.");
} else {
  console.log("Makhani Gravy Base already exists.");
}

// Repoint Butter Chicken: drop the base ingredients now folded into the gravy, add the base.
const bc = await prisma.item.findFirst({ where: { outletId: outlet.id, name: "Butter Chicken", deletedAt: null } });
if (bc) {
  const folded = ["Onion", "Tomato", "Butter", "Fresh Cream"].map((n) => byName.get(n)?.id).filter(Boolean);
  await prisma.recipeIngredient.deleteMany({
    where: { itemId: bc.id, rawMaterialId: { in: folded } },
  });
  const hasBase = await prisma.recipeIngredient.findFirst({ where: { itemId: bc.id, rawMaterialId: base.id } });
  if (!hasBase) {
    await prisma.recipeIngredient.create({ data: { itemId: bc.id, rawMaterialId: base.id, quantity: 0.15 } });
    console.log("Butter Chicken now uses 0.15 L Makhani Gravy Base.");
  }
}

await prisma.$disconnect();
