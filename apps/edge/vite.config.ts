import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The renderer is a plain SPA that talks only to the local master service (sidecar),
// so it keeps working with the WAN down. base './' so Electron can load it from file://.
export default defineConfig({
  plugins: [react()],
  base: "./",
  // @stello/shared is a pnpm-symlinked CommonJS package: widen Rollup's commonjs
  // interop for the production build and pre-bundle it for the dev server so its
  // named exports (applyTheme, getTheme, …) resolve.
  build: { commonjsOptions: { include: [/node_modules/, /packages\/shared/] } },
  optimizeDeps: { include: ["@stello/shared"] },
  server: { port: 5175 },
});
