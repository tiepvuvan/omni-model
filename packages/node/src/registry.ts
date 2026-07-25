import { createDefaultRegistry, type OmniRegistry } from "@omni-model/core";
import { postgresStorageFactory } from "@omni-model/postgres";

/**
 * The registry this container can build components from.
 *
 * `createDefaultRegistry` covers core's own components; the Postgres storage
 * backend lives outside core and has to be added here. It matters beyond
 * construction: `GET /admin/api/meta` publishes the registry so a dashboard can
 * render a form per component type, and a registry missing `postgres` would tell
 * an operator running on Postgres that only in-memory storage exists.
 */
export function containerRegistry(): OmniRegistry {
  const registry = createDefaultRegistry();
  registry.storage.set(postgresStorageFactory.type, postgresStorageFactory);
  return registry;
}
