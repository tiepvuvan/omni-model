import {
  appleAppAttestVerifierFactory,
  appleDeviceCheckVerifierFactory,
} from "./auth/apple/index.js";
import type { AuthVerifierFactory } from "./auth/types.js";
import {
  firebaseAppCheckVerifierFactory,
  firebaseAuthVerifierFactory,
  jwtVerifierFactory,
  supabaseVerifierFactory,
} from "./auth/verifiers/index.js";
import { anthropicProviderFactory } from "./providers/anthropic.js";
import { googleProviderFactory } from "./providers/google.js";
import { openAICompatibleProviderFactory, openAIProviderFactory } from "./providers/openai.js";
import type { ProviderFactory } from "./providers/types.js";
import { memoryStorageFactory } from "./storage/memory.js";
import type { StorageFactory } from "./storage/types.js";

/**
 * Registry of pluggable component factories, keyed by their `type`. Register
 * custom auth verifiers, model providers or storage backends here to extend
 * omni-model without forking core.
 */
export interface OmniRegistry {
  auth: Map<string, AuthVerifierFactory>;
  providers: Map<string, ProviderFactory>;
  storage: Map<string, StorageFactory>;
}

/** An empty registry. */
export function createRegistry(): OmniRegistry {
  return { auth: new Map(), providers: new Map(), storage: new Map() };
}

/**
 * A registry pre-populated with every built-in component. Platform-bound
 * storage backends (Cloudflare KV / Durable Objects — they need live
 * bindings) and the Redis/Postgres adapters (separate packages) are
 * registered by the respective deploy entries instead.
 */
export function createDefaultRegistry(): OmniRegistry {
  const registry = createRegistry();
  registry.storage.set(memoryStorageFactory.type, memoryStorageFactory);
  for (const factory of [
    jwtVerifierFactory,
    firebaseAuthVerifierFactory,
    supabaseVerifierFactory,
    firebaseAppCheckVerifierFactory,
    appleDeviceCheckVerifierFactory,
    appleAppAttestVerifierFactory,
  ]) {
    registry.auth.set(factory.type, factory);
  }
  for (const factory of [
    openAIProviderFactory,
    openAICompatibleProviderFactory,
    anthropicProviderFactory,
    googleProviderFactory,
  ]) {
    registry.providers.set(factory.type, factory);
  }
  return registry;
}
