import { omniConfigSchema } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { SCHEMA_DEFAULTS } from "../src/routes/_app/rate-limit";
import { CACHE_DEFAULTS, DEFAULT_PER_USER, SERVER_DEFAULTS } from "../src/routes/_app/settings";

/**
 * Every default the dashboard mirrors, checked against the real schema.
 *
 * `GET /config` returns the *stored* document, and a document that omits a block is
 * not a deployment without that feature — the schema fills it in and the proxy
 * enforces it. So the screens show those defaults, which means they hold copies,
 * which means the copies can go stale. This is the test that stops it: change a
 * default in core and this fails until the dashboard agrees.
 *
 * Copies rather than imports because the dashboard ships as a browser bundle and
 * does not depend on `@omni-model/core` at runtime — pulling zod, jose and the CEL
 * engine into it for a few literals would be a poor trade. In a test the dependency
 * is free.
 */
const applied = omniConfigSchema.parse({});

describe("the defaults the dashboard mirrors", () => {
  it("matches the rate-limit rules the schema fills in", () => {
    // Field for field, not just shape: a changed limit is exactly the drift that
    // would have a screen quoting a budget the proxy is not enforcing.
    expect(SCHEMA_DEFAULTS).toEqual(applied.rateLimits);
  });

  it("matches the in-flight bound", () => {
    expect(DEFAULT_PER_USER).toBe(applied.concurrency.perUser);
  });

  it("matches the cache settings", () => {
    expect(CACHE_DEFAULTS).toEqual(applied.cache);
  });

  it("matches the request input-token limit", () => {
    expect(SERVER_DEFAULTS.maxInputTokens).toBe(applied.server.maxInputTokens);
  });
});
