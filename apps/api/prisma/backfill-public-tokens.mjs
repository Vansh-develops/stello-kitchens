// One-time backfill: give every existing outlet + dining table an opaque publicToken
// so their kiosk / token-display / per-table Scan & Order URLs work. Idempotent.
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const tok = (n = 9) => randomBytes(n).toString("base64url");

const outlets = await prisma.outlet.findMany({ where: { publicToken: null } });
for (const o of outlets) {
  await prisma.outlet.update({ where: { id: o.id }, data: { publicToken: tok() } });
}

const tables = await prisma.diningTable.findMany({ where: { publicToken: null } });
for (const t of tables) {
  await prisma.diningTable.update({ where: { id: t.id }, data: { publicToken: tok() } });
}

console.log(`Backfilled ${outlets.length} outlet(s), ${tables.length} table(s).`);
await prisma.$disconnect();
