// Acceptance test for P1-1: per-platform inbound webhook signature verification.
// The connector must reject unsigned / tampered deliveries with 401 BEFORE parsing,
// and accept correctly-signed ones. Assumes the connector is running on :3003 with
// no *_WEBHOOK_SECRET env set (so it uses the dev fallback "dev-<platform>-secret").
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3003";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const hmac = (platform, body) => createHmac("sha256", `dev-${platform}-secret`).update(body).digest("hex");
const post = (platform, body, headers) =>
  fetch(`${BASE}/webhooks/${platform}/order`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

const zomato = (id = "Z-1") => JSON.stringify({ order_id: id, store: { pos_outlet_id: "outlet-x" }, order_items: [{ item_id: "i1", quantity: 2 }], order_total: 500 });
const swiggy = (id = "S-1") => JSON.stringify({ orderId: id, outletId: "outlet-x", items: [{ externalItemId: "i1", qty: 1 }], total: 300 });
const urbanpiper = (id = "U-1") => JSON.stringify({ order_ref: id, location_ref: "outlet-x", items: [{ ref_id: "i1", quantity: 1 }], amount: 200 });
const ondc = (id = "O-1") => JSON.stringify({ context: { transaction_id: id }, message: { order: { provider: { id: "outlet-x" }, items: [{ id: "i1", quantity: { count: 1 } }], quote: { price: { value: "250" } } } } });

async function main() {
  console.log("[1] Zomato HMAC — reject unsigned / tampered, accept signed");
  const zb = zomato("Z-100");
  ok((await post("zomato", zb, {})).status === 401, "no signature → 401 (rejected before parse)");
  ok((await post("zomato", zb, { "X-Zomato-Signature": "deadbeef" })).status === 401, "wrong signature → 401");
  const good = await post("zomato", zb, { "X-Zomato-Signature": hmac("zomato", zb) });
  ok(good.status === 202, "correct HMAC → 202 accepted");
  // Signature valid for a DIFFERENT body than the one sent → proves raw-byte binding.
  ok((await post("zomato", zomato("Z-TAMPER"), { "X-Zomato-Signature": hmac("zomato", zb) })).status === 401, "signature for a different body → 401 (tamper detected)");
  // Valid signature but malformed payload → 400 from parse, proving verify ran first and passed.
  const badBody = JSON.stringify({ order_id: "Z-BAD" });
  ok((await post("zomato", badBody, { "X-Zomato-Signature": hmac("zomato", badBody) })).status === 400, "valid signature + malformed body → 400 (verify passed, parse rejected)");

  console.log("\n[2] Swiggy & UrbanPiper HMAC");
  const sb = swiggy("S-100");
  ok((await post("swiggy", sb, {})).status === 401, "Swiggy unsigned → 401");
  ok((await post("swiggy", sb, { "X-Swiggy-Signature": hmac("swiggy", sb) })).status === 202, "Swiggy correct HMAC → 202");
  const ub = urbanpiper("U-100");
  ok((await post("urbanpiper", ub, {})).status === 401, "UrbanPiper unsigned → 401");
  ok((await post("urbanpiper", ub, { "X-UrbanPiper-Signature": hmac("urbanpiper", ub) })).status === 202, "UrbanPiper correct HMAC → 202");

  console.log("\n[3] ONDC ed25519 (GATED — structural check until registry key provisioned)");
  const ob = ondc("O-100");
  ok((await post("ondc", ob, {})).status === 401, "no Authorization → 401");
  ok((await post("ondc", ob, { authorization: 'Signature keyId="bpp|k1"' })).status === 401, "malformed signature block → 401");
  const wellFormed = 'Signature keyId="bpp.example|k1|ed25519",signature="ZHVtbXlzaWc="';
  ok((await post("ondc", ob, { authorization: wellFormed })).status === 202, "well-formed Beckn signature block → 202 (structural gate; live key GATED)");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });
