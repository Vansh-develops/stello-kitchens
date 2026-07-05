// End-to-end smoke test for Phase 9 (Scan & Order + kiosk + board + hardware).
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const j = async (res) => {
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};
const get = (p, tok) => fetch(`${API}${p}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then(j);
const post = (p, body, tok) =>
  fetch(`${API}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const postJson = async (p, body, tok) => j(await post(p, body, tok));

async function main() {
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const table = await prisma.diningTable.findFirstOrThrow({ where: { outletId: outlet.id, name: "T1" } });
  console.log(`Outlet ${outlet.name} (token …${outlet.publicToken?.slice(-4)}), table ${table.name}`);

  // 1. Diner fetches the table menu (no auth).
  console.log("\n[1] Public table menu");
  const menu = await get(`/public/scan/t/${table.publicToken}`);
  ok(menu?.mode === "DINE_IN", "mode is DINE_IN");
  ok(menu?.tableName === "T1", "table name surfaced");
  const cats = menu?.categories ?? [];
  const flatItems = cats.flatMap((c) => c.items);
  ok(flatItems.length > 0, `menu has ${flatItems.length} items`);
  const chicken65 = flatItems.find((i) => i.name === "Chicken 65");
  const paneerTikka = flatItems.find((i) => i.name === "Paneer Tikka");
  ok(!!chicken65 && !!paneerTikka, "found Chicken 65 + Paneer Tikka");

  // 2. Diner submits a cart -> pending request.
  console.log("\n[2] Submit order request");
  const variation = paneerTikka.variations[0];
  const submit = await postJson(`/public/scan/t/${table.publicToken}/order`, {
    items: [
      { itemId: chicken65.id, quantity: 2, note: "Extra spicy" },
      { itemId: paneerTikka.id, variationId: variation?.id, quantity: 1 },
    ],
    customerName: "Diner Dave",
    customerPhone: "9876500011",
    note: "Table by the window",
  });
  ok(!!submit?.requestToken, "got a request token to poll");

  // 3. Diner polls -> still PENDING.
  const pend = await get(`/public/scan/request/${submit.requestToken}`);
  ok(pend?.status === "PENDING", "request starts PENDING");

  // 4. Staff logs in and sees the pending request.
  console.log("\n[3] Staff validation");
  const login = await postJson(`/auth/login`, { email: "admin@demo.com", password: "password123" });
  const token = login.accessToken;
  ok(!!token, "admin logged in");
  const queue = await get(`/outlets/${outlet.id}/scan-requests`, token);
  const mine = queue.find((r) => r.customerName === "Diner Dave");
  ok(!!mine, `pending queue shows the request (${queue.length} pending)`);
  ok(mine?.items.length === 2, "request has 2 line items");
  ok(mine?.total > 0, `request is priced (₹${mine?.total})`);
  ok(mine?.tableName === "T1", "request tied to table T1");

  // 5. Staff accepts -> real order + KOT fires, token number assigned.
  const accepted = await postJson(`/outlets/${outlet.id}/scan-requests/${mine.id}/accept`, null, token);
  ok(accepted?.status === "ACCEPTED", "request marked ACCEPTED");
  ok(typeof accepted?.tokenNumber === "number", `token number assigned (#${accepted?.tokenNumber})`);

  // Verify a real order now exists on the table with the punched items.
  const openOrders = await get(`/orders?outletId=${outlet.id}`, token);
  const tableOrder = openOrders.find((o) => o.tableName === "T1");
  ok(!!tableOrder, "an OPEN order now sits on table T1");
  const names = tableOrder?.items.map((i) => i.itemName) ?? [];
  ok(names.includes("Chicken 65") && names.includes("Paneer Tikka"), "order carries the diner's items");
  ok((tableOrder?.kots.length ?? 0) >= 1, "a KOT was fired to the kitchen");

  // 6. Diner re-polls -> ACCEPTED with token number.
  const polled = await get(`/public/scan/request/${submit.requestToken}`);
  ok(polled?.status === "ACCEPTED" && polled?.tokenNumber === accepted.tokenNumber, "diner poll now shows ACCEPTED + token");

  // 7. Token-display board shows the token as preparing.
  console.log("\n[4] Token-display board");
  const board = await get(`/public/scan/board/${outlet.publicToken}`);
  ok(board?.preparing?.includes(accepted.tokenNumber), `board lists #${accepted.tokenNumber} under preparing`);

  // 8. Kiosk (takeaway) path.
  console.log("\n[5] Kiosk takeaway");
  const kmenu = await get(`/public/scan/kiosk/${outlet.publicToken}`);
  ok(kmenu?.mode === "TAKEAWAY" && kmenu?.tableName === null, "kiosk menu is TAKEAWAY, no table");
  const ksubmit = await postJson(`/public/scan/kiosk/${outlet.publicToken}/order`, {
    items: [{ itemId: chicken65.id, quantity: 1 }],
    customerName: "Kiosk Kim",
  });
  ok(!!ksubmit?.requestToken, "kiosk submission accepted");
  const kqueue = await get(`/outlets/${outlet.id}/scan-requests`, token);
  const kreq = kqueue.find((r) => r.customerName === "Kiosk Kim");
  ok(kreq?.mode === "TAKEAWAY", "kiosk request is TAKEAWAY");
  const kacc = await postJson(`/outlets/${outlet.id}/scan-requests/${kreq.id}/accept`, null, token);
  ok(kacc?.status === "ACCEPTED" && kacc.tokenNumber === accepted.tokenNumber + 1, "kiosk token is next in sequence");

  // 9. Reject path.
  console.log("\n[6] Reject");
  const rsubmit = await postJson(`/public/scan/t/${table.publicToken}/order`, {
    items: [{ itemId: chicken65.id, quantity: 99 }],
    customerName: "Prank Pete",
  });
  const rqueue = await get(`/outlets/${outlet.id}/scan-requests`, token);
  const rreq = rqueue.find((r) => r.customerName === "Prank Pete");
  const rej = await postJson(`/outlets/${outlet.id}/scan-requests/${rreq.id}/reject`, null, token);
  ok(rej?.status === "REJECTED", "prank request rejected (no KOT fired)");
  const rpoll = await get(`/public/scan/request/${rsubmit.requestToken}`);
  ok(rpoll?.status === "REJECTED", "diner poll shows REJECTED");

  // 10. Hardware bridge (mock).
  console.log("\n[7] Hardware bridge (mock)");
  const scale = await get(`/outlets/${outlet.id}/hardware/scale`, token);
  ok(typeof scale?.grams === "number" && scale.grams > 0, `scale reads ${scale?.grams} g (stable=${scale?.stable})`);
  const caller = await get(`/outlets/${outlet.id}/hardware/caller-id`, token);
  ok(!!caller?.phone, `caller-ID popped ${caller?.phone}`);
  const waiter = await postJson(`/public/scan/t/${table.publicToken}/call-waiter`, null);
  ok(waiter?.tableName === "T1", "diner paged a waiter from T1");

  // 11. Table QR list for the dashboard.
  console.log("\n[8] Dashboard table-QR list");
  const qrs = await get(`/outlets/${outlet.id}/scan-requests/table-qrs`, token);
  ok(Array.isArray(qrs) && qrs.length >= 8 && qrs.every((q) => q.token), `table-QR list has ${qrs.length} tables with tokens`);
  const ptok = await get(`/outlets/${outlet.id}/scan-requests/public-token`, token);
  ok(ptok?.token === outlet.publicToken, "outlet public token exposed for kiosk/board links");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("SMOKE ERROR:", e);
  await prisma.$disconnect();
  process.exit(1);
});
