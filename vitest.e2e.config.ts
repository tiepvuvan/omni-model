import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// End-to-end tests that hit a real upstream (OpenRouter). Separate from the
// default suite so `pnpm test` stays fast and offline. Run with `pnpm test:e2e`
// and OPENROUTER_API_KEY set; the tests skip themselves when the key is absent.
export default defineConfig({
  resolve: {
    alias: {
      "@omni-model/core": pkg("core/src/index.ts"),
      "@omni-model/storage-redis": pkg("storage-redis/src/index.ts"),
      "@omni-model/storage-postgres": pkg("storage-postgres/src/index.ts"),
      "@omni-model/storage-firestore": pkg("storage-firestore/src/index.ts"),
      "@omni-model/cloudflare": pkg("cloudflare/src/index.ts"),
      "@omni-model/firebase": pkg("firebase/src/index.ts"),
      "@omni-model/node": pkg("node/src/index.ts"),
    },
  },
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 30_000,
  },
});
