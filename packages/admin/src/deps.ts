import type {
  BundleHolder,
  ConfigStore,
  Logger,
  OmniRegistry,
  RuntimeContext,
  SecretStore,
  WriteKeyStore,
} from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";

/**
 * Everything the admin API operates on.
 *
 * All of it already exists behind a contract from earlier phases, which is why
 * this package is mostly HTTP surface and authorization rather than new
 * mechanism.
 */
export interface AdminDeps {
  /** Reconfigures this instance and reports what is applied. */
  holder: BundleHolder;
  /** Where revisions are persisted; saving one reaches every replica. */
  configStore: ConfigStore;
  writeKeys: WriteKeyStore;
  /** Null when no master key is configured; secret endpoints then 503. */
  secrets: SecretStore | null;
  /** For log queries. Null when not running on Postgres. */
  pool: PgPoolLike | null;
  /** Registered component types, for the schema endpoint. */
  registry: OmniRegistry;
  /** Passed to provider probes. */
  runtime: RuntimeContext;
  logger?: Logger;
}
