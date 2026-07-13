import type { AuthVerifierFactory } from "./auth/types.js";
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

/** A registry pre-populated with every built-in component. */
export function createDefaultRegistry(): OmniRegistry {
  const registry = createRegistry();
  registry.storage.set(memoryStorageFactory.type, memoryStorageFactory);
  return registry;
}
