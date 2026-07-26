import { fileURLToPath } from "node:url";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = (path: string): string => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

const alias = {
  "@omni-model/admin": pkg("admin/src/index.ts"),
  "@omni-model/core": pkg("core/src/index.ts"),
  "@omni-model/postgres": pkg("postgres/src/index.ts"),
  "@omni-model/node": pkg("node/src/index.ts"),
};

/**
 * Two projects, one `pnpm test`.
 *
 * The engine packages run in Node with no DOM; the dashboard needs jsdom, JSX and
 * a per-test cleanup. Splitting them as projects rather than as a second command
 * is what keeps "the whole suite" a single thing to run — a separate script is a
 * suite that eventually stops being run.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "engine",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/dashboard/**"],
        },
      },
      {
        plugins: [viteReact()],
        resolve: { alias },
        test: {
          name: "dashboard",
          root: pkg("dashboard"),
          environment: "jsdom",
          globals: true,
          include: ["test/**/*.test.{ts,tsx}"],
          setupFiles: ["./test/setup.ts"],
        },
      },
    ],
  },
});
