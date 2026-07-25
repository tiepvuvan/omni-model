import { ConfigError, interpolateDeep } from "@omni-model/core";
import { resolveConfigSource } from "./config.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The database URL, read the way the server reads it at boot.
 *
 * Every command shares `resolveConfigSource` + `interpolateDeep` with
 * `startServer` rather than reading `DATABASE_URL` directly. A deployment that
 * points the server at one database and a command at another is a much worse
 * failure than a missing variable: the migration, the operator or the
 * configuration lands somewhere nothing reads.
 *
 * `command` only shapes the error message, so the fix names the thing that
 * failed.
 */
export function postgresUrl(env: Record<string, string | undefined>, command: string): string {
  const { config } = resolveConfigSource({ env });
  const storage = record(
    record(config === undefined ? undefined : interpolateDeep(config, env))?.storage,
  );
  const type = typeof storage?.type === "string" ? storage.type : "memory";
  if (type !== "postgres") {
    throw new ConfigError(
      `${command} needs PostgreSQL storage; set OMNI_STORAGE_TYPE=postgres and ` +
        "OMNI_STORAGE_POSTGRES_URL",
    );
  }
  const url = storage?.url;
  if (typeof url !== "string" || url === "") {
    throw new ConfigError(`${command} needs a database URL (set OMNI_STORAGE_POSTGRES_URL)`);
  }
  return url;
}
