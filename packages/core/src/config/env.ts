import { ConfigError } from "../errors.js";
import { parseConfigObject } from "./load.js";
import type { OmniConfig } from "./schema.js";

/** Prefix for environment variables that form an omni-model configuration path. */
export const ENV_CONFIG_PREFIX = "OMNI__";

const JSON_BLOCKS: ReadonlyArray<readonly [name: string, path: readonly string[]]> = [
  ["OMNI_CONFIG_JSON", []],
  ["OMNI_SERVER_JSON", ["server"]],
  ["OMNI_STORAGE_JSON", ["storage"]],
  ["OMNI_SECURITY_JSON", ["security"]],
  ["OMNI_SECURITY_PROVIDERS_JSON", ["security", "providers"]],
  ["OMNI_RATE_LIMITS_JSON", ["rateLimits"]],
  ["OMNI_PROVIDERS_JSON", ["providers"]],
  ["OMNI_ROUTING_JSON", ["routing"]],
];

const SIMPLE_VALUES: ReadonlyArray<readonly [name: string, path: readonly string[]]> = [
  ["OMNI_LOG_LEVEL", ["server", "logLevel"]],
  ["OMNI_STORAGE_TYPE", ["storage", "type"]],
  ["OMNI_SECURITY_MODE", ["security", "mode"]],
  ["OMNI_DEFAULT_PROVIDER", ["routing", "defaultProvider"]],
];

type ConfigPathSegment = number | string;
type ConfigContainer = Record<string, unknown> | unknown[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function isContainer(value: unknown): value is ConfigContainer {
  return Array.isArray(value) || isObject(value);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function mergeConfigValue(current: unknown, incoming: unknown): unknown {
  if (isObject(current) && isObject(incoming)) {
    const result: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      result[key] = key in result ? mergeConfigValue(result[key], value) : clone(value);
    }
    return result;
  }
  return clone(incoming);
}

function formatPath(path: ConfigPathSegment[]): string {
  return path.reduce<string>((result, segment) => {
    return typeof segment === "number" ? `${result}[${segment}]` : `${result}.${segment}`;
  }, "$");
}

function environmentKeyToPath(key: string): ConfigPathSegment[] {
  const encodedPath = key.slice(ENV_CONFIG_PREFIX.length);
  if (encodedPath.length === 0) {
    throw new ConfigError(`${key}: expected a path after ${ENV_CONFIG_PREFIX}`);
  }

  const segments = encodedPath.split("__");
  if (segments.some((segment) => segment.length === 0)) {
    throw new ConfigError(`${key}: path segments must be separated by exactly two underscores`);
  }

  return segments.map((segment, index) => {
    if (/^\d+$/.test(segment)) {
      const value = Number(segment);
      if (Number.isSafeInteger(value) === false) {
        throw new ConfigError(`${key}: array index "${segment}" is too large`);
      }
      if (index === 0) {
        throw new ConfigError(`${key}: a configuration path cannot start with an array index`);
      }
      return value;
    }

    const words = segment.split("_");
    return words
      .map((word, wordIndex) => {
        const lower = word.toLowerCase();
        return wordIndex === 0 ? lower : `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
      })
      .join("");
  });
}

function parseEnvironmentValue(value: string, key: string): unknown {
  const trimmed = value.trim();
  const startsJson = /^[[{"]/.test(trimmed);
  const isPrimitive =
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);

  if (startsJson || isPrimitive) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${key}: invalid JSON value (${message})`);
    }
  }
  return value;
}

function parseJsonBlock(value: string, key: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${key}: expected valid JSON (${message})`);
  }
}

function setPath(
  root: Record<string, unknown>,
  path: ConfigPathSegment[],
  value: unknown,
  key: string,
  overwrite = false,
): void {
  let container: ConfigContainer = root;

  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    const isLast = index === path.length - 1;
    const nextSegment = path[index + 1];

    if (segment === undefined) {
      throw new ConfigError(`${key}: invalid empty configuration path`);
    }
    let existing: unknown;
    if (Array.isArray(container)) {
      if (typeof segment !== "number") {
        throw new ConfigError(
          `${key}: ${formatPath(path.slice(0, index))} must use an array index`,
        );
      }
      existing = container[segment];
    } else {
      if (typeof segment !== "string") {
        throw new ConfigError(`${key}: ${formatPath(path.slice(0, index))} must use an object key`);
      }
      existing = container[segment];
    }
    if (isLast) {
      if (existing !== undefined && overwrite === false) {
        throw new ConfigError(`${key}: duplicates the configuration path ${formatPath(path)}`);
      }
      if (Array.isArray(container)) {
        container[segment as number] = value;
      } else {
        container[segment as string] = value;
      }
      return;
    }

    const expectsArray = typeof nextSegment === "number";
    if (existing === undefined) {
      const child: ConfigContainer = expectsArray ? [] : {};
      if (Array.isArray(container)) {
        container[segment as number] = child;
      } else {
        container[segment as string] = child;
      }
      container = child;
      continue;
    }
    if (
      isContainer(existing) === false ||
      (expectsArray && Array.isArray(existing) === false) ||
      (expectsArray === false && isObject(existing) === false)
    ) {
      throw new ConfigError(
        `${key}: conflicts with the configuration path ${formatPath(path.slice(0, index + 1))}`,
      );
    }
    container = existing;
  }
}

function applyBlock(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
  key: string,
): void {
  if (path.length === 0) {
    if (isObject(value) === false) {
      throw new ConfigError(`${key}: a full configuration must be a JSON object`);
    }
    const merged = mergeConfigValue(root, value);
    for (const keyToDelete of Object.keys(root)) delete root[keyToDelete];
    Object.assign(root, merged);
    return;
  }

  let container: Record<string, unknown> = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined) throw new ConfigError(`${key}: invalid JSON block path`);
    const existing = container[segment];
    if (existing === undefined) {
      const child: Record<string, unknown> = {};
      container[segment] = child;
      container = child;
    } else if (isObject(existing)) {
      container = existing;
    } else {
      throw new ConfigError(`${key}: conflicts with ${formatPath(path.slice(0, index + 1))}`);
    }
  }
  const last = path[path.length - 1];
  if (last === undefined) throw new ConfigError(`${key}: invalid JSON block path`);
  container[last] = last in container ? mergeConfigValue(container[last], value) : clone(value);
}

function isEnvironmentConfigKey(key: string): boolean {
  return (
    key.startsWith(ENV_CONFIG_PREFIX) ||
    JSON_BLOCKS.some(([name]) => name === key) ||
    SIMPLE_VALUES.some(([name]) => name === key)
  );
}

/**
 * Returns whether the environment contains an omni-model configuration
 * variable (`OMNI_CONFIG_JSON`, a named JSON block, an alias, or `OMNI__...`).
 */
export function hasEnvironmentConfig(env: Record<string, string | undefined>): boolean {
  return Object.entries(env).some(
    ([key, value]) => isEnvironmentConfigKey(key) && value !== undefined,
  );
}

/**
 * Build an omni-model configuration document entirely from environment
 * variables. `OMNI_CONFIG_JSON` accepts the whole document, while
 * `OMNI_PROVIDERS_JSON`, `OMNI_ROUTING_JSON`, and sibling block variables
 * accept complex sections. Friendly scalar variables and `OMNI__...` paths
 * then override those blocks. Double underscores separate object keys and
 * numeric segments create array entries. SCREAMING_SNAKE_CASE segments are
 * converted to lowerCamelCase, so `OMNI__SERVER__MAX_BODY_BYTES=3000000`
 * becomes `server.maxBodyBytes: 3000000`.
 *
 * Values use JSON literals when their type matters: arrays and objects use
 * JSON, while `true`, `false`, `null`, and JSON numbers are converted to their
 * natural types. Other values remain strings. Use a JSON string such as
 * `"123"` for an otherwise-ambiguous string value.
 */
export function environmentConfigDocument(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  if (hasEnvironmentConfig(env) === false) {
    throw new ConfigError(
      "no environment configuration found; set OMNI_CONFIG_JSON or OMNI__... variables",
    );
  }

  const document: Record<string, unknown> = {};
  for (const [name, path] of JSON_BLOCKS) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      applyBlock(document, path, parseJsonBlock(value, name), name);
    }
  }
  for (const [name, path] of SIMPLE_VALUES) {
    const value = env[name];
    if (value !== undefined)
      setPath(document, [...path], parseEnvironmentValue(value, name), name, true);
  }

  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith(ENV_CONFIG_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    setPath(document, environmentKeyToPath(key), parseEnvironmentValue(value, key), key, true);
  }
  return document;
}

/**
 * Parse and validate an omni-model configuration supplied entirely through
 * the supported environment variables.
 */
export function parseEnvironmentConfig(env: Record<string, string | undefined>): OmniConfig {
  return parseConfigObject(environmentConfigDocument(env), env);
}
