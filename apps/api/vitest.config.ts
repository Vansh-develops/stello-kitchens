import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false, // shared test DB — run files serially
    hookTimeout: 60000,
    testTimeout: 30000,
    setupFiles: ["test/db.ts"],
  },
});
