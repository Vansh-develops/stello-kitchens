// Acceptance test for themeable Edge: the offline engine must cache the brand's
// themeId from the /sync/snapshot payload and surface it on status(), so the
// renderer can style itself from the brand theme with the WAN down. Runs fully
// offline — it drives the engine directly, no cloud required.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { EdgeEngine } = require("./sidecar/engine.js");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const newEngine = () => new EdgeEngine({ dataDir: mkdtempSync(join(tmpdir(), "edge-theme-")), apiUrl: "http://localhost:3001/api/v1" });
const snap = (themeId) => ({ menu: [], areas: [], themeId });

console.log("[1] themeId from the snapshot is cached and exposed on status()");
{
  const engine = newEngine();
  engine.cacheSnapshot(snap("noir"));
  ok(engine.status().themeId === "noir", `status().themeId === "noir" (got ${JSON.stringify(engine.status().themeId)})`);
}

console.log("\n[2] A later sync refreshes the cached theme (owner changed it in Console)");
{
  const engine = newEngine();
  engine.cacheSnapshot(snap("counter"));
  engine.cacheSnapshot(snap("thali"));
  ok(engine.status().themeId === "thali", `re-cache updates themeId → "thali" (got ${JSON.stringify(engine.status().themeId)})`);
}

console.log("\n[3] Before any snapshot, themeId is null (renderer falls back to the default theme)");
{
  const engine = newEngine();
  ok(engine.status().themeId === null, `fresh device → themeId === null (got ${JSON.stringify(engine.status().themeId)})`);
}

console.log("\n[4] A snapshot missing themeId (older cache/API) degrades to null, not undefined/crash");
{
  const engine = newEngine();
  engine.cacheSnapshot({ menu: [], areas: [] });
  ok(engine.status().themeId === null, `absent themeId → null (got ${JSON.stringify(engine.status().themeId)})`);
}

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
