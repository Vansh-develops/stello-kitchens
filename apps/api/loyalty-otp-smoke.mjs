// Smoke test for OTP-gated loyalty redemption at billing.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const call = (method, p, body, tok) =>
  fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const login = await j(await call("POST", `/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const pointValue = Number(outlet.loyaltyPointValue);
  const phone = "9812300099";
  const menu = await j(await call("GET", `/outlets/${outlet.id}/menu`, null, token));
  const chicken65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65"); // ₹290, 5% tax

  // 0. Earn points: settle an order for this phone.
  console.log("\n[0] Earn points");
  const o1 = await j(await call("POST", `/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: chicken65.id, quantity: 1 }] }, token));
  const total1 = round2(290 * 1.05); // single 5%-tax item
  await call("POST", `/orders/${o1.id}/settle`, { payments: [{ mode: "CASH", amount: total1 }], customerPhone: phone }, token);
  const cust = await prisma.customer.findUnique({ where: { outletId_phone: { outletId: outlet.id, phone } } });
  ok(cust && cust.loyaltyPoints >= 10, `customer now has ${cust?.loyaltyPoints} points`);

  const redeem = 10;
  const redeemDiscount = redeem * pointValue;
  const total2 = round2((290 - redeemDiscount) * 1.05);

  // 1. Settling with points but no OTP is rejected.
  console.log("\n[1] Redemption requires an OTP");
  const o2 = await j(await call("POST", `/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: chicken65.id, quantity: 1 }] }, token));
  const noOtp = await call("POST", `/orders/${o2.id}/settle`, { payments: [{ mode: "CASH", amount: total2 }], customerPhone: phone, redeemPoints: redeem }, token);
  ok(noOtp.status === 400, `settle with points but no OTP → rejected (${noOtp.status})`);

  // 2. Request an OTP.
  console.log("\n[2] Request OTP");
  const req = await j(await call("POST", `/outlets/${outlet.id}/loyalty/request-otp`, { phone }, token));
  ok(req?.sent === true, `OTP requested (customer has ${req?.points} pts)`);
  const otpRow = await prisma.loyaltyOtp.findFirst({ where: { outletId: outlet.id, phone, consumedAt: null }, orderBy: { createdAt: "desc" } });
  ok(otpRow && /^\d{6}$/.test(otpRow.code), `a 6-digit OTP was generated + stored`);

  // 3. Wrong OTP is rejected.
  console.log("\n[3] Wrong OTP");
  const wrong = await call("POST", `/orders/${o2.id}/settle`, { payments: [{ mode: "CASH", amount: total2 }], customerPhone: phone, redeemPoints: redeem, redeemOtp: "000000" }, token);
  ok(wrong.status === 400, `wrong OTP → rejected (${wrong.status})`);
  const stillOpen = await j(await call("GET", `/orders/${o2.id}`, null, token));
  ok(stillOpen.status === "OPEN", "order stays OPEN after a failed redemption (tx rolled back)");

  // 4. Correct OTP settles + redeems.
  console.log("\n[4] Correct OTP redeems");
  const pointsBefore = (await prisma.customer.findUnique({ where: { outletId_phone: { outletId: outlet.id, phone } } })).loyaltyPoints;
  const good = await j(await call("POST", `/orders/${o2.id}/settle`, { payments: [{ mode: "CASH", amount: total2 }], customerPhone: phone, redeemPoints: redeem, redeemOtp: otpRow.code }, token));
  ok(good?.status === "SETTLED", `order settled with the correct OTP (bill ${good?.billNumber})`);
  ok(good?.discountAmount >= redeemDiscount - 0.01, `points discount applied (₹${good?.discountAmount})`);
  // The bill earns points too, so the net balance rises; verify the REDEEM ledger entry.
  const redeemTxn = await prisma.loyaltyTransaction.findFirst({
    where: { customer: { outletId: outlet.id, phone }, type: "REDEEM", points: -redeem },
    orderBy: { createdAt: "desc" },
  });
  ok(!!redeemTxn, `a REDEEM ledger entry of -${redeem} points was recorded (balance ${pointsBefore} → ${(await prisma.customer.findUnique({ where: { outletId_phone: { outletId: outlet.id, phone } } })).loyaltyPoints} incl. this bill's earn)`);

  // 5. The OTP is single-use.
  console.log("\n[5] OTP is single-use");
  const consumed = await prisma.loyaltyOtp.findUnique({ where: { id: otpRow.id } });
  ok(consumed.consumedAt !== null, "OTP marked consumed");
  const o3 = await j(await call("POST", `/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: chicken65.id, quantity: 1 }] }, token));
  const reuse = await call("POST", `/orders/${o3.id}/settle`, { payments: [{ mode: "CASH", amount: total2 }], customerPhone: phone, redeemPoints: redeem, redeemOtp: otpRow.code }, token);
  ok(reuse.status === 400, `reusing a consumed OTP → rejected (${reuse.status})`);
  await call("POST", `/orders/${o3.id}/cancel`, null, token); // cleanup the open order

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
