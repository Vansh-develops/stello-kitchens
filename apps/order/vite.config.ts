import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { precacheManifest } from "./pwa-plugin";

export default defineConfig({
  plugins: [react(), precacheManifest()],
  build: { commonjsOptions: { include: [/node_modules/, /packages\/shared/] } },
  optimizeDeps: { include: ["@stello/shared"] },
  server: {
    port: 5176,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
