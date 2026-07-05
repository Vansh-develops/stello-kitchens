import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The renderer is a plain SPA that talks only to the local master service (sidecar),
// so it keeps working with the WAN down. base './' so Electron can load it from file://.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5175 },
});
