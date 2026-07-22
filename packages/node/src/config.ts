import { ConfigError, environmentConfigDocument, hasEnvironmentConfig } from "@omni-model/core";

/** Arguments for {@link resolveConfigSource}. */
export interface ResolveConfigSourceArgs {
  /** Process environment containing the omni-model configuration variables. */
  env: Record<string, string | undefined>;
}

/** A resolved environment configuration plus a human-readable origin. */
export interface ConfigSource {
  /** Unvalidated configuration document assembled from environment variables. */
  config: Record<string, unknown>;
  /** Where the config came from, for the startup log. */
  source: "environment variables";
}

/**
 * Resolve the Node server configuration entirely from environment variables.
 * `OMNI_CONFIG_JSON` accepts a complete JSON document; dedicated JSON blocks,
 * friendly scalar names, and `OMNI__...` paths provide progressively more
 * granular overrides. Configuration files and inline YAML are intentionally
 * unsupported.
 */
export function resolveConfigSource(args: ResolveConfigSourceArgs): ConfigSource {
  if (hasEnvironmentConfig(args.env) === false) {
    throw new ConfigError(
      "no configuration found; set OMNI_CONFIG_JSON, a JSON block such as OMNI_PROVIDERS_JSON, " +
        "or OMNI__... environment variables",
    );
  }
  return { config: environmentConfigDocument(args.env), source: "environment variables" };
}
