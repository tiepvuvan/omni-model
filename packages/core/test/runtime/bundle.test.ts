import { describe, expect, it } from "vitest";
import type { AuthVerifierFactory } from "../../src/auth/types.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { createDefaultRegistry, createRegistry } from "../../src/registry.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";
import { buildBundle } from "../../src/runtime/bundle.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import type { RuntimeContext } from "../../src/types.js";
import { createAlwaysAuthenticatedFactory, createFakeProviderSetup } from "../server/helpers.js";

function runtime(): RuntimeContext {
  return {
    env: {},
    fetch: (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch,
    now: () => 1_750_000_000_000,
    waitUntil: () => {},
    log: silentLogger,
  };
}

/** A verifier whose contributed routes are supplied by the test. */
function routeContributingFactory(
  paths: readonly string[],
  name = "router-verifier",
): AuthVerifierFactory {
  return {
    type: "route-verifier",
    create(options) {
      return {
        type: "route-verifier",
        name: typeof options.name === "string" ? options.name : name,
        verify: async () => null,
        routes: paths.map((path) => ({
          method: "GET" as const,
          path,
          handler: async () => new Response("ok"),
        })),
      };
    },
  };
}

function build(
  config: unknown,
  extra?: (registry: ReturnType<typeof createDefaultRegistry>) => void,
) {
  const registry = createDefaultRegistry();
  const { factory } = createFakeProviderSetup();
  registry.providers.set(factory.type, factory);
  registry.auth.set("test-authenticated", createAlwaysAuthenticatedFactory());
  extra?.(registry);
  return buildBundle({
    config,
    registry,
    storage: new MemoryStorageAdapter(),
    engine: new CelExpressionEngine(),
    runtime: runtime(),
    logger: silentLogger,
  });
}

const MINIMAL = {
  version: 1,
  storage: { type: "memory" },
  security: { providers: [{ type: "test-authenticated" }] },
  providers: { main: { type: "fake" } },
  routing: { defaultProvider: "main" },
};

describe("buildBundle", () => {
  it("produces a bundle that satisfies the pipeline contract", () => {
    const bundle = build(MINIMAL);
    // These four fields are what `executeChat` consumes; a bundle is passed to
    // it directly, so the shape has to keep matching.
    expect(bundle.providers.has("main")).toBe(true);
    expect(typeof bundle.router.resolve).toBe("function");
    expect(typeof bundle.limiter.check).toBe("function");
    expect(bundle.log).toBeDefined();
    expect(bundle.revision).toBeNull();
  });

  it("carries the revision it was built from", () => {
    const registry = createDefaultRegistry();
    const { factory } = createFakeProviderSetup();
    registry.providers.set(factory.type, factory);
    registry.auth.set("test-authenticated", createAlwaysAuthenticatedFactory());
    const bundle = buildBundle({
      config: MINIMAL,
      registry,
      storage: new MemoryStorageAdapter(),
      engine: new CelExpressionEngine(),
      runtime: runtime(),
      logger: silentLogger,
      revision: 7,
    });
    expect(bundle.revision).toBe(7);
  });

  it("builds CORS middleware only when configured", () => {
    expect(build(MINIMAL).corsMiddleware).toBeNull();
    const withCors = build({
      ...MINIMAL,
      server: { cors: { allowOrigins: ["https://a.example"] } },
    });
    expect(withCors.corsMiddleware).toBeTypeOf("function");
  });

  it("refuses a configuration with no verifier, and says how to fix it", () => {
    expect(() => build({ ...MINIMAL, security: { providers: [] } })).toThrow(ConfigError);
    expect(() => build({ ...MINIMAL, security: { providers: [] } })).toThrow(/type: jwt/);
  });

  it("names the unknown type and what is registered", () => {
    expect(() => build({ ...MINIMAL, providers: { main: { type: "nope" } } })).toThrow(
      /providers\.main.*"nope".*fake/s,
    );
    expect(() => build({ ...MINIMAL, security: { providers: [{ type: "nope" }] } })).toThrow(
      /security\.providers\[0\].*"nope"/s,
    );
  });

  it("resolves environment references at build time, not at store time", () => {
    // Regression: stored revisions keep their `${VAR}` references so the
    // database never holds a secret, which means whoever turns a document into
    // something runnable has to resolve them. Skipping this once shipped a
    // literal "${DATABASE_URL}" to the Postgres driver.
    const registry = createDefaultRegistry();
    const { factory, instances } = createFakeProviderSetup();
    registry.providers.set(factory.type, factory);
    registry.auth.set("test-authenticated", createAlwaysAuthenticatedFactory());

    const bundle = buildBundle({
      config: { ...MINIMAL, providers: { main: { type: "fake", apiKey: "$" + "{SECRET_KEY}" } } },
      registry,
      storage: new MemoryStorageAdapter(),
      engine: new CelExpressionEngine(),
      runtime: { ...runtime(), env: { SECRET_KEY: "sk-resolved" } },
      logger: silentLogger,
    });

    expect(bundle.config.providers.main).toMatchObject({ apiKey: "sk-resolved" });
    expect(instances.get("main")).toBeDefined();
  });

  it("fails loudly when a referenced variable is missing", () => {
    // Better than silently constructing a provider with a literal "${VAR}" key
    // and failing on the first upstream call.
    expect(() =>
      build({ ...MINIMAL, providers: { main: { type: "fake", apiKey: "$" + "{NOT_SET}" } } }),
    ).toThrow(/NOT_SET/);
  });

  it("rejects invalid configuration with the same message shape as everywhere else", () => {
    expect(() => build({ version: 2 })).toThrow(ConfigError);
    expect(() => build({ version: 2 })).toThrow(/invalid configuration/);
  });

  it("indexes verifier routes by method and path", () => {
    const bundle = build(
      { ...MINIMAL, security: { providers: [{ type: "route-verifier" }] } },
      (registry) =>
        registry.auth.set("route-verifier", routeContributingFactory(["/auth/a", "/auth/b"])),
    );
    expect([...bundle.authRoutes.keys()].sort()).toEqual(["GET /auth/a", "GET /auth/b"]);
  });

  it("rejects a verifier route that would shadow a path the proxy owns", () => {
    // Silently shadowing /v1/chat/completions with an unauthenticated handler
    // would be a security hole, not a quirk.
    for (const path of ["/v1/chat/completions", "/healthz", "/readyz", "/admin/api/config"]) {
      expect(() =>
        build({ ...MINIMAL, security: { providers: [{ type: "route-verifier" }] } }, (registry) =>
          registry.auth.set("route-verifier", routeContributingFactory([path])),
        ),
      ).toThrow(/reserved path/);
    }
  });

  it("rejects two verifiers claiming the same route", () => {
    expect(() =>
      build(
        {
          ...MINIMAL,
          security: {
            mode: "any",
            providers: [
              { type: "route-verifier", name: "first" },
              { type: "route-verifier", name: "second" },
            ],
          },
        },
        (registry) => registry.auth.set("route-verifier", routeContributingFactory(["/auth/x"])),
      ),
    ).toThrow(/two verifiers claim the route/);
  });

  it("reports an empty registry rather than a bare failure", () => {
    expect(() =>
      buildBundle({
        config: MINIMAL,
        registry: createRegistry(),
        storage: new MemoryStorageAdapter(),
        engine: new CelExpressionEngine(),
        runtime: runtime(),
        logger: silentLogger,
      }),
    ).toThrow(/none registered/);
  });
});
