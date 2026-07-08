// Acceptance test for P1-2: atomic loyalty redemption.
// A customer with exactly R points has TWO orders, each trying to redeem all R.
// Fired concurrently, only ONE may redeem — the balance can never go negative and
// the points can never be spent twice, because the check+decrement is a single
// conditional update inside the settle transaction.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const call = (m, p, b, tok) => fetch(`${API}${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });

async function main() {
  const token = (await j(await call("POST", "/auth/login", { email: "admin@demo.com", password: "password123" }))).accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const menu = await j(await call("GET", `/outlets/${outlet.id}/menu`, null, token));
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const pointValue = Number(outlet.loyaltyPointValue);
  const earnRate = Number(outlet.loyaltyEarnRate);
  const phone = `9${String(Date.now()).slice(-9)}`; // unique customer

  // Choose R so the redemption discount stays comfortably under the ₹290 subtotal.
  const R = Math.max(1, Math.min(50, Math.floor(150 / pointValue)));
  const redeemDiscount = R * pointValue;

  // Seed a customer holding EXACTLY R points.
  await prisma.customer.create({ data: { tenantId: outlet.tenantId, outletId: outlet.id, phone, name: "Race Tester", loyaltyPoints: R } });

  // Compute the exact settle total for a single Chicken 65 with the redemption discount.
  const subtotal = 290, taxRate = 5;
  const discountAmount = Math.min(redeemDiscount, subtotal);
  const taxable = subtotal - discountAmount;
  // Match recomputeTotals exactly: total uses the UNROUNDED tax figure.
  const taxAmount = ((subtotal * taxRate) / 100) * (taxable / subtotal);
  const total = Math.round((taxable + taxAmount) * 100) / 100;

  // Two independent orders for the same customer.
  const mkOrder = async () => (await j(await call("POST", "/orders", { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }], customerPhone: phone, customerName: "Race Tester" }, token))).id;
  const orderA = await mkOrder();
  const orderB = await mkOrder();

  // One OTP; both settlements present the same code (OTP is not the guard under test).
  await call("POST", `/outlets/${outlet.id}/loyalty/request-otp`, { phone }, token);
  const otp = await prisma.loyaltyOtp.findFirstOrThrow({ where: { outletId: outlet.id, phone, consumedAt: null }, orderBy: { createdAt: "desc" } });

  console.log("\n[1] Concurrent double-redeem of the same balance");
  const body = { payments: [{ mode: "CASH", amount: total }], redeemPoints: R, redeemOtp: otp.code, customerPhone: phone };
  const [ra, rb] = await Promise.all([
    call("POST", `/orders/${orderA}/settle`, body, token),
    call("POST", `/orders/${orderB}/settle`, body, token),
  ]);
  const statuses = [ra.status, rb.status].sort();
  const wins = [ra.status, rb.status].filter((s) => s < 300).length;
  ok(wins === 1, `exactly one settlement succeeded (statuses ${statuses.join("/")})`);
  ok(statuses.includes(400), "the loser was rejected (400 — not enough points)");

  console.log("\n[2] Balance integrity");
  const customer = await prisma.customer.findUniqueOrThrow({ where: { outletId_phone: { outletId: outlet.id, phone } } });
  ok(customer.loyaltyPoints >= 0, `final balance is never negative (${customer.loyaltyPoints})`);
  const winnerEarned = Math.round(total * earnRate);
  ok(customer.loyaltyPoints === winnerEarned, `final balance = winner's earned points only (${customer.loyaltyPoints} === ${winnerEarned}); redeemed R=${R} once, not twice`);

  const redeemTxns = await prisma.loyaltyTransaction.findMany({ where: { customerId: customer.id, type: "REDEEM", orderId: { in: [orderA, orderB] } } });
  ok(redeemTxns.length === 1, `exactly one REDEEM ledger entry across both orders (${redeemTxns.length})`);
  ok(redeemTxns.reduce((s, t) => s + Math.abs(t.points), 0) === R, `total points redeemed = ${R} (not ${2 * R})`);

  const settled = await prisma.order.count({ where: { id: { in: [orderA, orderB] }, status: "SETTLED" } });
  ok(settled === 1, `exactly one order is SETTLED; the loser stays open (${settled})`);

  console.log("\n[3] Insufficient balance is rejected outright");
  const otp2 = await prisma.loyaltyOtp.create({ data: { tenantId: outlet.tenantId, outletId: outlet.id, phone, code: "654321", expiresAt: new Date(Date.now() + 300000) } });
  const orderC = await mkOrder();
  const over = await call("POST", `/orders/${orderC}/settle`, { payments: [{ mode: "CASH", amount: total }], redeemPoints: R + 1000, redeemOtp: otp2.code, customerPhone: phone }, token);
  ok(over.status === 400, `redeeming more than the balance is rejected (${over.status})`);
  await call("POST", `/orders/${orderC}/cancel`, null, token);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
