// Idempotently give the seeded Koramangala outlet a small device fleet
// (the existing "Counter 1" plus a KDS screen and a receipt printer).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });

// Tag the existing Counter 1 as a POS with an empty config.
await prisma.terminal.updateMany({
  where: { outletId: outlet.id, name: "Counter 1" },
  data: { type: "POS" },
});

const defs = [
  { name: "Kitchen Screen", type: "KDS", config: { theme: "dark", density: "comfortable", sound: true, columns: 3 } },
  { name: "Counter Printer", type: "PRINTER", config: { paperWidth: "80mm", autoPrintKot: true, autoPrintBill: true, copies: 1 } },
];
let created = 0;
for (const d of defs) {
  const exists = await prisma.terminal.findFirst({ where: { outletId: outlet.id, name: d.name } });
  if (exists) continue;
  await prisma.terminal.create({
    data: { tenantId: outlet.tenantId, outletId: outlet.id, name: d.name, type: d.type, config: d.config },
  });
  created++;
}
console.log(`Fleet: created ${created} device(s) (${defs.length - created} already existed).`);
await prisma.$disconnect();
