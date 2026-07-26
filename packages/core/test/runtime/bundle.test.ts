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
  layer: "user" | "app" = "user",
): AuthVerifierFactory {
  return {
    type: layer === "user" ? "route-verifier" : "route-app-verifier",
    layer,
    create(options) {
      return {
        type: layer === "user" ? "route-verifier" : "route-app-verifier",
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
  security: { userAuth: { type: "test-authenticated" } },
  routing: { rules: [{ id: "main", when: "true", target: { type: "fake" } }] },
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
    expect(() => build({ ...MINIMAL, security: {} })).toThrow(ConfigError);
    expect(() => build({ ...MINIMAL, security: {} })).toThrow(/type: jwt/);
  });

  it("names the unknown type and what is registered", () => {
    expect(() =>
      build({
        ...MINIMAL,
        routing: { rules: [{ id: "main", when: "true", target: { type: "nope" } }] },
      }),
    ).toThrow(/routing\.rules\[0\]\.target.*"nope".*fake/s);
    expect(() => build({ ...MINIMAL, security: { userAuth: { type: "nope" } } })).toThrow(
      /security\.userAuth.*"nope"/s,
    );
    expect(() =>
      build({
        ...MINIMAL,
        security: {
          userAuth: { type: "test-authenticated" },
          appAuth: { providers: [{ type: "nope" }] },
        },
      }),
    ).toThrow(/security\.appAuth\.providers\[0\].*"nope"/s);
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
      config: {
        ...MINIMAL,
        routing: {
          rules: [
            { id: "main", when: "true", target: { type: "fake", apiKey: "$" + "{SECRET_KEY}" } },
          ],
        },
      },
      registry,
      storage: new MemoryStorageAdapter(),
      engine: new CelExpressionEngine(),
      runtime: { ...runtime(), env: { SECRET_KEY: "sk-resolved" } },
      logger: silentLogger,
    });

    expect(bundle.config.routing.rules[0]?.target).toMatchObject({ apiKey: "sk-resolved" });
    expect(instances.get("main")).toBeDefined();
  });

  it("fails loudly when a referenced variable is missing", () => {
    // Better than silently constructing a provider with a literal "${VAR}" key
    // and failing on the first upstream call.
    expect(() =>
      build({
        ...MINIMAL,
        routing: {
          rules: [
            { id: "main", when: "true", target: { type: "fake", apiKey: "$" + "{NOT_SET}" } },
          ],
        },
      }),
    ).toThrow(/NOT_SET/);
  });

  it("keeps a target's model out of the provider's options", () => {
    // Regression, caught on a container rather than here: `model` is the rule's
    // choice of what to forward as, and every real factory validates with
    // `strictObject`, so passing the whole target through was rejected as an
    // unrecognized key. Uses a *real* provider type on purpose — the `fake` one
    // has a permissive schema and cannot catch this.
    const bundle = build({
      ...MINIMAL,
      routing: {
        rules: [
          {
            id: "real",
            when: "true",
            target: {
              type: "openai-compatible",
              baseUrl: "https://upstream.test/v1",
              apiKey: "sk-test",
              model: "gpt-4o-mini",
            },
          },
        ],
      },
    });
    expect(bundle.providers.get("real")?.type).toBe("openai-compatible");
    // And the rule still forwards as that model.
    expect(bundle.config.routing.rules[0]?.target.model).toBe("gpt-4o-mini");
  });

  it("rejects a duplicate rule id, which logs and the admin API address by", () => {
    expect(() =>
      build({
        ...MINIMAL,
        routing: {
          rules: [
            { id: "same", when: "true", target: { type: "fake" } },
            { id: "same", when: "true", target: { type: "fake" } },
          ],
        },
      }),
    ).toThrow(/duplicate rule id "same"/);
  });

  it("rejects invalid configuration with the same message shape as everywhere else", () => {
    expect(() => build({ version: 2 })).toThrow(ConfigError);
    expect(() => build({ version: 2 })).toThrow(/invalid configuration/);
  });

  it("indexes verifier routes by method and path", () => {
    const bundle = build(
      { ...MINIMAL, security: { userAuth: { type: "route-verifier" } } },
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
        build({ ...MINIMAL, security: { userAuth: { type: "route-verifier" } } }, (registry) =>
          registry.auth.set("route-verifier", routeContributingFactory([path])),
        ),
      ).toThrow(/reserved path/);
    }
  });

  it("rejects two verifiers claiming the same route", () => {
    // One route can only have one handler, and the two layers are collected into
    // one table — so a collision across layers has to be caught too.
    expect(() =>
      build(
        {
          ...MINIMAL,
          security: {
            userAuth: { type: "route-verifier", name: "first" },
            appAuth: { providers: [{ type: "route-app-verifier", name: "second" }] },
          },
        },
        (registry) => {
          registry.auth.set("route-verifier", routeContributingFactory(["/auth/x"]));
          registry.auth.set(
            "route-app-verifier",
            routeContributingFactory(["/auth/x"], "router-verifier", "app"),
          );
        },
      ),
    ).toThrow(/two verifiers claim the route/);
  });

  it("builds both layers, and refuses one configured in the wrong half", () => {
    const bundle = build(
      {
        ...MINIMAL,
        security: {
          userAuth: { type: "test-authenticated" },
          appAuth: { mode: "any", providers: [{ type: "route-app-verifier" }] },
        },
      },
      (registry) =>
        registry.auth.set(
          "route-app-verifier",
          routeContributingFactory(["/auth/attest"], "attestation", "app"),
        ),
    );
    expect(bundle.userVerifier.type).toBe("test-authenticated");
    expect(bundle.appVerifiers.map((verifier) => verifier.type)).toEqual(["route-app-verifier"]);
    expect(bundle.appAuthMode).toBe("any");
    // Routes come from both layers.
    expect([...bundle.authRoutes.keys()]).toEqual(["GET /auth/attest"]);

    expect(() =>
      build({ ...MINIMAL, security: { userAuth: { type: "route-app-verifier" } } }, (registry) =>
        registry.auth.set(
          "route-app-verifier",
          routeContributingFactory(["/auth/attest"], "attestation", "app"),
        ),
      ),
    ).toThrow(/verifies an app or device, not a user/);
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
