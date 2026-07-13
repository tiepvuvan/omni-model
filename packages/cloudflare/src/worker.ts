import type { Logger, OmniRegistry } from "@omni-model/core";
import { ConfigError, createDefaultRegistry, createOmniApp, parseConfig } from "@omni-model/core";
import type { DurableObjectNamespaceLike, KVNamespaceLike } from "./cf-types.js";
import { createDurableObjectStorageFactory } from "./durable-object.js";
import { createKVStorageFactory } from "./kv.js";

/**
 * The Workers `env` object: bindings (KV namespaces, Durable Object
 * namespaces, secrets, vars) keyed by their wrangler binding name. String
 * values are exposed to config interpolation; object bindings are consumed
 * here to build storage factories.
 */
export interface WorkerEnv {
  [binding: string]: unknown;
}

/** Options for {@link createWorker}. */
export interface CreateWorkerOptions {
  /**
   * YAML configuration bundled at build time (e.g. imported as a Text
   * module). The `OMNI_CONFIG` var/secret, when set and non-empty, takes
   * precedence so a deployment can be reconfigured without rebuilding.
   */
  configYaml?: string;
  /** Component factories; defaults to `createDefaultRegistry()`. */
  registry?: OmniRegistry;
  /** Defaults to the console logger at the configured log level. */
  logger?: Logger;
}

/** Structural subset of the Workers `ExecutionContext`. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** The default-exportable Workers handler produced by {@link createWorker}. */
export interface OmniWorker {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>;
}

type OmniApp = Awaited<ReturnType<typeof createOmniApp>>;

function bindingNameFor(storage: Record<string, unknown>, fallback: string): string {
  const binding = storage.binding;
  return typeof binding === "string" && binding.length > 0 ? binding : fallback;
}

function missingBinding(storageType: string, binding: string, expected: string): ConfigError {
  return new ConfigError(
    `storage type "${storageType}" requires ${expected} bound as "${binding}" ` +
      `(env.${binding} is missing or not a namespace); declare the binding in wrangler.jsonc ` +
      `or point storage.binding at the one you declared`,
  );
}

function isKVNamespace(value: unknown): value is KVNamespaceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { put?: unknown }).put === "function"
  );
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespaceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

/**
 * Build a Cloudflare Workers handler around the omni-model app.
 *
 * The app is constructed lazily on the first request (Workers only expose
 * `env` per-request) and memoized per worker instance — including failures,
 * which are configuration mistakes that a redeploy must fix. Failed init
 * surfaces as a 500 with an OpenAI-style error body instead of an opaque
 * exception, and is logged via `console.error`.
 *
 * Config resolution order: the `OMNI_CONFIG` var/secret (non-empty string)
 * wins over `options.configYaml`. When the resolved config selects
 * `cloudflare-kv` or `durable-object` storage, the corresponding namespace
 * binding (default `OMNI_KV` / `OMNI_DO`, overridable via `storage.binding`)
 * is pulled from `env` and registered as the storage factory.
 */
export function createWorker(options: CreateWorkerOptions = {}): OmniWorker {
  let appPromise: Promise<OmniApp> | undefined;

  const init = async (env: WorkerEnv): Promise<OmniApp> => {
    const stringEnv = Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;

    const inlineYaml =
      typeof env.OMNI_CONFIG === "string" && env.OMNI_CONFIG.trim() !== ""
        ? env.OMNI_CONFIG
        : undefined;
    const yaml = inlineYaml ?? options.configYaml;
    if (yaml === undefined) {
      throw new ConfigError(
        "no configuration found: set the OMNI_CONFIG var/secret to your YAML config " +
          "or bundle one at build time via createWorker({ configYaml })",
      );
    }

    const config = parseConfig(yaml, stringEnv);
    const registry = options.registry ?? createDefaultRegistry();

    // Namespace bindings only exist on the Workers `env`, so the two
    // platform-bound storage factories are constructed here rather than in
    // `createDefaultRegistry`.
    if (config.storage.type === "cloudflare-kv") {
      const binding = bindingNameFor(config.storage, "OMNI_KV");
      const namespace = env[binding];
      if (!isKVNamespace(namespace)) {
        throw missingBinding("cloudflare-kv", binding, "a KV namespace");
      }
      registry.storage.set("cloudflare-kv", createKVStorageFactory(namespace));
    } else if (config.storage.type === "durable-object") {
      const binding = bindingNameFor(config.storage, "OMNI_DO");
      const namespace = env[binding];
      if (!isDurableObjectNamespace(namespace)) {
        throw missingBinding("durable-object", binding, "a Durable Object namespace");
      }
      registry.storage.set("durable-object", createDurableObjectStorageFactory(namespace));
    }

    return createOmniApp({ config, registry, env: stringEnv, logger: options.logger });
  };

  const initOnce = (env: WorkerEnv): Promise<OmniApp> => {
    if (appPromise === undefined) {
      appPromise = init(env);
      // The settled promise stays cached either way; the no-op handler keeps
      // a failure from being reported as an unhandled rejection.
      appPromise.catch(() => {});
    }
    return appPromise;
  };

  return {
    async fetch(request, env, ctx) {
      let app: OmniApp;
      try {
        app = await initOnce(env);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[omni] worker initialization failed: ${message}`);
        return Response.json(
          { error: { message, type: "api_error", param: null, code: null } },
          { status: 500 },
        );
      }
      // Hono receives the execution context so `c.executionCtx.waitUntil`
      // carries post-response work (usage recording) on Workers. The cast
      // widens our structural ctx to Hono's ExecutionContext shape.
      return app.fetch(request, env, ctx as Parameters<OmniApp["fetch"]>[2]);
    },
  };
}
