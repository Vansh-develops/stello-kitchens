// Acceptance test for P2-1: explicit device-to-outlet binding.
// A terminal binds to exactly the outlet it is provisioned for — chosen by id,
// never by guessing a name or defaulting to the first outlet — and once bound it
// will not silently rebind to a different outlet.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { EdgeEngine } = require("./sidecar/engine.js");

const API = "http://localhost:3001/api/v1";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const fresh = () => new EdgeEngine({ dataDir: mkdtempSync(join(tmpdir(), "edge-bind-")), apiUrl: API });
const admin = { email: "admin@demo.com", password: "password123" };
const cashier = { email: "cashier@demo.com", password: "password123" };
async function throws(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

async function main() {
  const login = await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(admin) })).json();
  const outlets = await (await fetch(`${API}/outlets`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json();
  const kora = outlets.find((o) => o.name.includes("Koramangala"));
  const indi = outlets.find((o) => o.name.includes("Indiranagar"));

  console.log("[1] Binds to the explicitly requested outlet");
  const eA = fresh();
  const rA = await eA.bootstrap({ ...admin, outletId: kora.id });
  ok(rA.outletId === kora.id && eA.outletId === kora.id, `explicit Koramangala id → bound to Koramangala`);
  // And an admin can bind a different device to Indiranagar — not hardcoded to one store.
  const eB = fresh();
  const rB = await eB.bootstrap({ ...admin, outletId: indi.id });
  ok(rB.outletId === indi.id, `explicit Indiranagar id → bound to Indiranagar (not name-guessed)`);

  console.log("\n[2] Ambiguous / invalid bindings are refused, device left unbound");
  const eC = fresh();
  const errC = await throws(() => eC.bootstrap({ ...admin })); // 2 outlets, none specified
  ok(errC && /multiple outlets/i.test(errC) && !eC.outletId, `multi-outlet account + no outletId → error, unbound (${errC ? "threw" : "did not throw"})`);
  const eD = fresh();
  const errD = await throws(() => eD.bootstrap({ ...admin, outletId: "outlet-does-not-exist" }));
  ok(errD && /not accessible/i.test(errD) && !eD.outletId, `inaccessible outletId → error, unbound`);

  console.log("\n[3] Single-outlet account binds unambiguously");
  const eE = fresh();
  const rE = await eE.bootstrap({ ...cashier });
  ok(rE.outletId === kora.id, `cashier (one outlet) + no outletId → bound to that outlet`);

  console.log("\n[4] A bound device will not silently rebind");
  const eF = fresh();
  await eF.bootstrap({ ...admin, outletId: kora.id });
  const errF = await throws(() => eF.bootstrap({ ...admin, outletId: indi.id }));
  ok(errF && /already bound/i.test(errF) && eF.outletId === kora.id, `rebind to a different outlet → refused, stays on Koramangala`);
  const rG = await eF.bootstrap({ ...admin }); // no outletId → reuse existing binding
  ok(rG.outletId === kora.id, `re-bootstrap with no outletId → reuses the existing binding`);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });
