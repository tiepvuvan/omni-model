import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@omni-model/core": pkg("core/src/index.ts"),
      "@omni-model/storage-redis": pkg("storage-redis/src/index.ts"),
      "@omni-model/storage-postgres": pkg("storage-postgres/src/index.ts"),
      "@omni-model/cloudflare": pkg("cloudflare/src/index.ts"),
      "@omni-model/node": pkg("node/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
