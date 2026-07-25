import { ConfigError, environmentConfigDocument, hasEnvironmentConfig } from "@omni-model/core";

/** Removed variables, mapped to what replaced them. */
const REMOVED_VARIABLES: ReadonlyArray<readonly [name: string, replacement: string]> = [
  ["OMNI_CONFIG", "OMNI_CONFIG_JSON"],
  ["OMNI_CONFIG_PATH", "OMNI_CONFIG_JSON"],
];

/** Arguments for {@link resolveConfigSource}. */
export interface ResolveConfigSourceArgs {
  /** Process environment containing the omni-model configuration variables. */
  env: Record<string, string | undefined>;
}

/** A resolved bootstrap configuration plus a human-readable origin. */
export interface ConfigSource {
  /**
   * Unvalidated configuration document assembled from environment variables, or
   * `undefined` when the environment carries none.
   */
  config: Record<string, unknown> | undefined;
  /** Where the config came from, for the startup log. */
  source: "environment variables" | "none";
}

/**
 * Resolve the bootstrap configuration from environment variables.
 * `OMNI_CONFIG_JSON` accepts a complete JSON document; dedicated JSON blocks,
 * friendly scalar names, and `OMNI__...` paths provide progressively more
 * granular overrides. Configuration files and inline YAML are intentionally
 * unsupported.
 *
 * An empty environment is **not** an error: the proxy boots unconfigured and is
 * configured through the admin API. A *removed* variable still is an error,
 * because silently ignoring it would look like the setting had been applied.
 */
export function resolveConfigSource(args: ResolveConfigSourceArgs): ConfigSource {
  for (const [name, replacement] of REMOVED_VARIABLES) {
    if (args.env[name] !== undefined) {
      throw new ConfigError(
        `${name} is no longer supported; use ${replacement} (a complete JSON document), the ` +
          "named JSON blocks, or OMNI__... paths",
      );
    }
  }
  if (hasEnvironmentConfig(args.env) === false) {
    return { config: undefined, source: "none" };
  }
  return { config: environmentConfigDocument(args.env), source: "environment variables" };
}
