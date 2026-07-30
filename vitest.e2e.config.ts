import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// End-to-end tests that boot real servers and optionally reach live providers.
// Separate from the default suite so `pnpm test` stays fast and offline. Each
// live suite owns its credential gate and skips itself when that gate is closed.
export default defineConfig({
  resolve: {
    alias: {
      "@omni-model/admin": pkg("admin/src/index.ts"),
      "@omni-model/core": pkg("core/src/index.ts"),
      "@omni-model/postgres": pkg("postgres/src/index.ts"),
      "@omni-model/node": pkg("node/src/index.ts"),
    },
  },
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 30_000,
  },
});
