import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

// Fills the precache list and cache version into the hand-written public/sw.js
// after the build. Vite copies public/ verbatim, so we patch dist/sw.js in
// closeBundle once every emitted file name (content-hashed) is known.
export function precacheManifest(): Plugin {
  let config: ResolvedConfig;
  const emitted = new Set<string>();

  return {
    name: "stello-order-precache",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    generateBundle(_opts, bundle) {
      for (const file of Object.keys(bundle)) {
        if (file.endsWith(".map") || file === "index.html") continue;
        emitted.add(`/${file}`);
      }
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const swPath = resolve(outDir, "sw.js");
      if (!existsSync(swPath)) return;

      const statics = ["/manifest.webmanifest", "/icons/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
      const urls = [...[...emitted].sort(), ...statics.filter((u) => existsSync(resolve(outDir, u.slice(1))))];

      const html = readFileSync(resolve(outDir, "index.html"));
      const version = createHash("sha256").update(urls.join("\n")).update(html).digest("hex").slice(0, 10);

      const src = readFileSync(swPath, "utf8")
        .replace('"__SW_VERSION__"', JSON.stringify(version))
        .replace("/* __PRECACHE_MANIFEST__ */ []", JSON.stringify(urls));
      writeFileSync(swPath, src);
      config.logger.info(`[pwa] sw.js ${version}: ${urls.length} precached files`);
    },
  };
}
