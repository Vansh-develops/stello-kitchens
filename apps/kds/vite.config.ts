import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Workspace packages (e.g. @stello/shared) resolve to files outside
    // node_modules via pnpm symlinks; Rollup's default commonjs handling
    // only inspects node_modules, so widen it to pick up the CJS build.
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared/],
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      // Socket.IO handshake + upgrade
      "/socket.io": { target: "http://localhost:3001", ws: true, changeOrigin: true },
    },
  },
});
