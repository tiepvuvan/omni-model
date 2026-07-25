import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_SECRET_VARIABLE, AUTH_BASE_PATH } from "../src/auth.js";
import { baseConfig, createTestAdmin } from "./helpers.js";

/**
 * The admin API reference against the real routing table.
 *
 * Documentation for an HTTP surface rots in a specific way: an endpoint is
 * renamed and the curl example keeps looking plausible. These assertions make
 * that a failing test rather than a support question.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../docs/reference/admin-api.mdx", import.meta.url)),
  "utf8",
);

describe("the admin API reference", () => {
  it("names the variables the code actually reads", () => {
    expect(page).toContain(ADMIN_SECRET_VARIABLE);
    expect(page).toContain(AUTH_BASE_PATH);
    for (const variable of ["OMNI_ENCRYPTION_KEY", "OMNI_ADMIN_BASE_URL"]) {
      expect(page, variable).toContain(variable);
    }
  });

  it("documents the create-admin command as the CLI implements it", () => {
    expect(page).toContain("omni-model create-admin --email");
    expect(page).toContain("OMNI_ADMIN_PASSWORD");
  });

  /**
   * Every documented path, extracted from the reference's own tables and curl
   * examples, must be routable. A 404 here means the docs describe an endpoint
   * that does not exist.
   */
  it("documents only endpoints that exist", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    // `/healthz` and `/readyz` are deliberately excluded: they belong to the
    // proxy app, which the page says, and are covered by its own suite.
    const documented = new Set(
      [...page.matchAll(/`(GET|POST|PUT|DELETE)\s+(\/admin\/api[^\s`?]*)`/g)].map(
        ([, method, path]) => `${method} ${path}`,
      ),
    );
    // Guard against the regex silently matching nothing.
    expect(documented.size).toBeGreaterThan(15);

    for (const entry of documented) {
      const [method, path] = entry.split(" ") as [string, string];
      // Placeholders in the docs are not valid ids; any answer other than 404
      // proves the route is registered.
      const concrete = path.replace(/:requestId/, "req-1").replace(/:id|:n/g, "abc");
      const response = await call(concrete, {
        method,
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
      });
      if (response.status !== 404) continue;
      // A routed handler answering "that id does not exist" renders a JSON error;
      // an *unrouted* path falls through to Hono's plain-text 404. That is the
      // difference between a documented resource being absent and a documented
      // endpoint being absent.
      const body: unknown = await response.json().catch(() => null);
      expect(
        (body as { error?: unknown } | null)?.error,
        `${method} ${concrete} is documented but not routed`,
      ).toBeDefined();
    }
  });
});
