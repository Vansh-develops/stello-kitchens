// Idempotently add the two demo combos to the already-seeded Koramangala outlet.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
const items = await prisma.item.findMany({ where: { outletId: outlet.id, deletedAt: null } });
const byName = new Map(items.map((i) => [i.name, i.id]));
const mainCourse = await prisma.menuCategory.findFirstOrThrow({
  where: { outletId: outlet.id, name: "Main Course", deletedAt: null },
});
const opt = (name, priceDelta = 0, isDefault = false) => ({ itemId: byName.get(name), priceDelta, isDefault });

const defs = [
  {
    name: "Chicken Lover's Meal",
    price: 499,
    isVeg: false,
    slots: [
      { name: "Main", options: [opt("Chicken Biryani", 0, true), opt("Butter Chicken", 20)] },
      { name: "Drink", options: [opt("Soft Drink", 0, true), opt("Sweet Lassi", 30)] },
      { name: "Dessert", options: [opt("Gulab Jamun", 0, true), opt("Rasmalai", 20)] },
    ],
  },
  {
    name: "Veg Thali Combo",
    price: 399,
    isVeg: true,
    slots: [
      { name: "Sabzi", options: [opt("Paneer Butter Masala", 0, true), opt("Dal Makhani")] },
      { name: "Bread", options: [opt("Butter Naan", 0, true), opt("Garlic Naan", 10)] },
      { name: "Dessert", options: [opt("Gulab Jamun", 0, true), opt("Rasmalai", 20)] },
    ],
  },
];

let created = 0;
for (const d of defs) {
  const exists = await prisma.combo.findFirst({ where: { outletId: outlet.id, name: d.name, deletedAt: null } });
  if (exists) continue;
  await prisma.combo.create({
    data: {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      categoryId: mainCourse.id,
      name: d.name,
      price: d.price,
      isVeg: d.isVeg,
      taxRate: 5,
      slots: {
        create: d.slots.map((s, si) => ({
          name: s.name,
          sortOrder: si,
          options: { create: s.options },
        })),
      },
    },
  });
  created++;
}
console.log(`Created ${created} combo(s) (${defs.length - created} already existed).`);
await prisma.$disconnect();
