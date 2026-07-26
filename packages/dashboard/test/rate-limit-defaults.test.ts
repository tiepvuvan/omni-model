import { omniConfigSchema } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { SCHEMA_DEFAULTS } from "../src/routes/_app/rate-limit";

/**
 * The screen's stand-in for an absent `rateLimits` block must be the real one.
 *
 * `GET /config` returns the *stored* document, and a document that omits the block
 * is not a deployment without limits — the schema supplies defaults and the proxy
 * enforces them. So the screen shows those defaults, which means it holds a copy of
 * them, which means the copy can go stale. This is the test that stops it: change
 * the default in core and this fails until the dashboard agrees.
 *
 * A copy rather than an import because the dashboard ships as a browser bundle and
 * does not depend on `@omni-model/core` at runtime — pulling zod, jose and the CEL
 * engine into the bundle for two literals would be a poor trade. In a test the
 * dependency is free.
 */
describe("the rate-limit defaults the screen falls back to", () => {
  it("matches what the schema fills an absent block in with", () => {
    const applied = omniConfigSchema.parse({}).rateLimits;

    // Field for field, not just shape: a changed limit is exactly the drift that
    // would have the screen quoting a budget the proxy is not enforcing.
    expect(SCHEMA_DEFAULTS).toEqual(applied);
  });
});
