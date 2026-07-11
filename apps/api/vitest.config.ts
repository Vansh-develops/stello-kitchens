import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  // Nest's DI resolves un-@Inject()'d constructor params via TypeScript's
  // emitDecoratorMetadata (design:paramtypes). Vitest's default esbuild
  // transform does not reliably emit that metadata, which breaks any test
  // that boots a real Nest DI container (e.g. Test.createTestingModule /
  // NestFactory.create) — see test/platform.e2e.test.ts. Use SWC (Nest's own
  // documented recipe for Vitest) so decorator metadata is emitted correctly.
  plugins: [swc.vite({ module: { type: "es6" } })],
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
