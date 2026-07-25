import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@omni-model/core": pkg("core/src/index.ts"),
      "@omni-model/postgres": pkg("postgres/src/index.ts"),
      "@omni-model/node": pkg("node/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
