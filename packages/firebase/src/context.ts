import {
  CelExpressionEngine,
  type ChatProvider,
  ConfigError,
  createConsoleLogger,
  createDefaultRegistry,
  createRateLimiter,
  createRouter,
  type Logger,
  type OmniConfig,
  type OmniRegistry,
  type PipelineDeps,
  type RuntimeContext,
  type StorageAdapter,
} from "@omni-model/core";
import { createFirestoreStorageFactory, type FirestoreLike } from "@omni-model/storage-firestore";

/**
 * Everything a callable handler needs to run the core pipeline: the assembled
 * {@link PipelineDeps}, the {@link RuntimeContext} it drives them with, the
 * validated config, and the shared storage adapter.
 */
export interface OmniContext {
  deps: PipelineDeps;
  runtime: RuntimeContext;
  config: OmniConfig;
  storage: StorageAdapter;
}

/**
 * Dependencies for {@link buildOmniContext}. `firestore` is supplied by the
 * embedder (it carries credentials), and the Firestore storage factory is
 * registered from it under the `firestore` type. The remaining fields override
 * the runtime services, defaulting to the platform globals. An optional
 * `registry` lets an embedder pre-register custom components (extra providers
 * or backends); it defaults to the built-in registry.
 */
export interface BuildOmniContextDeps {
  firestore: FirestoreLike;
  fetch?: typeof fetch;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
  logger?: Logger;
  registry?: OmniRegistry;
}

function registeredTypes(registry: ReadonlyMap<string, unknown>): string {
  const types = [...registry.keys()].sort();
  return types.length === 0 ? "none registered" : types.join(", ");
}

/**
 * Assemble the {@link OmniContext} for a Firebase deployment: build the runtime,
 * register the Firestore storage factory, construct the configured storage
 * backend and providers, then wire the router and rate limiter.
 *
 * All component construction happens here, so configuration mistakes (unknown
 * storage/provider types, bad CEL expressions) throw {@link ConfigError} at
 * startup rather than mid-request.
 */
export async function buildOmniContext(
  config: OmniConfig,
  deps: BuildOmniContextDeps,
): Promise<OmniContext> {
  const log = deps.logger ?? createConsoleLogger(config.server.logLevel);
  const baseFetch = deps.fetch ?? globalThis.fetch;
  // Wrap so the default global keeps its `this` binding (avoids Illegal invocation).
  const fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => baseFetch(...args);
  const runtime: RuntimeContext = {
    env: {},
    fetch: fetchImpl,
    now: deps.now ?? Date.now,
    waitUntil:
      deps.waitUntil ??
      ((promise: Promise<unknown>): void => {
        void promise.catch(() => {});
      }),
    log,
  };

  const registry = deps.registry ?? createDefaultRegistry();
  registry.storage.set("firestore", createFirestoreStorageFactory(deps.firestore));

  const storageFactory = registry.storage.get(config.storage.type);
  if (storageFactory === undefined) {
    throw new ConfigError(
      `storage: unknown type "${config.storage.type}" ` +
        `(registered storage types: ${registeredTypes(registry.storage)})`,
    );
  }
  const storage = await storageFactory.create(config.storage, runtime);

  const providers = new Map<string, ChatProvider>();
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const factory = registry.providers.get(providerConfig.type);
    if (factory === undefined) {
      throw new ConfigError(
        `providers.${id}: unknown provider type "${providerConfig.type}" ` +
          `(registered provider types: ${registeredTypes(registry.providers)})`,
      );
    }
    providers.set(id, factory.create(id, providerConfig, runtime));
  }

  const engine = new CelExpressionEngine();
  const router = createRouter(config.routing, new Set(providers.keys()), engine, log);
  const limiter = createRateLimiter(config.rateLimits, { storage, engine, log, now: runtime.now });

  return { deps: { providers, router, limiter, log }, runtime, config, storage };
}
