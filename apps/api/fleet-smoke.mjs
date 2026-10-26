// Smoke test for device fleet management: CRUD, config, heartbeat, backup, RBAC.
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
const get = (p, tok) => call("GET", p, null, tok).then(j);

async function main() {
  const login = await j(await call("POST", `/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });

  // 1. Seeded fleet.
  console.log("\n[1] Fleet listing");
  const devices = await get(`/outlets/${outlet.id}/devices`, token);
  ok(devices.length >= 3, `${devices.length} devices registered`);
  ok(devices.some((d) => d.type === "POS") && devices.some((d) => d.type === "KDS"), "POS and KDS present");
  // Printers moved out of the fleet into outlets/:id/printers.
  ok(!devices.some((d) => d.type === "PRINTER"), "no legacy PRINTER devices");

  // 2. Register a device (defaults applied).
  console.log("\n[2] Register");
  const kiosk = await j(await call("POST", `/outlets/${outlet.id}/devices`, { name: "Lobby Kiosk", type: "KIOSK" }, token));
  ok(kiosk?.type === "KIOSK" && kiosk.isActive, "kiosk registered and active");
  const kds = await j(await call("POST", `/outlets/${outlet.id}/devices`, { name: "Expo Screen", type: "KDS" }, token));
  ok(kds.config.theme === "dark" && kds.config.columns === 3, "new KDS gets default theme + columns");

  // 3. Configure a throwaway KDS (defaults → update) so seeded state stays clean.
  console.log("\n[3] Configure");
  const testPrinter = await j(await call("POST", `/outlets/${outlet.id}/devices`, { name: "Test Screen", type: "KDS" }, token));
  const updated = await j(await call("PATCH", `/outlets/${outlet.id}/devices/${testPrinter.id}`, { config: { theme: "light", density: "compact", sound: false, columns: 4 } }, token));
  ok(updated.config.theme === "light" && updated.config.columns === 4, "KDS config updated (light, 4 columns)");

  // 4. Heartbeat → online.
  console.log("\n[4] Heartbeat");
  const beat = await j(await call("POST", `/public/devices/heartbeat`, { deviceToken: testPrinter.deviceToken }));
  ok(beat?.ok === true, "device heartbeat accepted (no auth)");
  const after = (await get(`/outlets/${outlet.id}/devices`, token)).find((d) => d.id === testPrinter.id);
  ok(after.lastSeenAt && Date.now() - new Date(after.lastSeenAt).getTime() < 60_000, "lastSeenAt updated → shows online");

  // 5. Disable a device.
  console.log("\n[5] Enable/disable");
  const disabled = await j(await call("PATCH", `/outlets/${outlet.id}/devices/${kiosk.id}`, { isActive: false }, token));
  ok(disabled.isActive === false, "device can be disabled");

  // 6. Config backup.
  console.log("\n[6] Config backup");
  const backup = await get(`/outlets/${outlet.id}/devices/backup`, token);
  ok(backup.counts.items > 0 && backup.counts.tables > 0, `backup counts: ${backup.counts.items} items, ${backup.counts.tables} tables, ${backup.counts.devices} devices`);
  ok(backup.menu.length === backup.counts.categories, "backup includes the full menu by category");
  ok(backup.devices.some((d) => d.type === "KDS" && d.config.columns === 4), "backup reflects updated device config");
  ok(backup.tables.length === backup.counts.tables, "backup lists every table");

  // 7. RBAC: a cashier (no devices.manage / no *) is blocked.
  console.log("\n[7] RBAC");
  const cashier = await j(await call("POST", `/auth/login`, { email: "cashier@demo.com", password: "password123" }));
  const res = await call("GET", `/outlets/${outlet.id}/devices`, null, cashier.accessToken);
  ok(res.status === 403, `cashier cannot manage the fleet (${res.status})`);

  // 8. Cleanup the test devices.
  await call("DELETE", `/outlets/${outlet.id}/devices/${kiosk.id}`, null, token);
  await call("DELETE", `/outlets/${outlet.id}/devices/${kds.id}`, null, token);
  await call("DELETE", `/outlets/${outlet.id}/devices/${testPrinter.id}`, null, token);
  const final = await get(`/outlets/${outlet.id}/devices`, token);
  ok(!final.some((d) => d.id === kiosk.id || d.id === kds.id), "test devices removed");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
