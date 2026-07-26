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
  ["OMNI_ROUTING_JSON", ["routing"]],
  ["OMNI_LOGGING_JSON", ["logging"]],
];

const SIMPLE_VALUES: ReadonlyArray<readonly [name: string, path: readonly string[]]> = [
  ["OMNI_LOG_LEVEL", ["server", "logLevel"]],
  ["OMNI_LOGGING_REQUESTS", ["logging", "requests"]],
  ["OMNI_LOGGING_CONTENT", ["logging", "content"]],
  ["OMNI_LOGGING_RETENTION", ["logging", "retention"]],
  ["OMNI_LOGGING_CONTENT_RETENTION", ["logging", "contentRetention"]],
  ["OMNI_SERVER_LOG_LEVEL", ["server", "logLevel"]],
  ["OMNI_SERVER_TRUST_PROXY_HEADERS", ["server", "trustProxyHeaders"]],
  ["OMNI_SERVER_MAX_BODY_BYTES", ["server", "maxBodyBytes"]],
  ["OMNI_SERVER_CORS", ["server", "cors"]],
  ["OMNI_STORAGE_TYPE", ["storage", "type"]],
  ["OMNI_SECURITY_MODE", ["security", "mode"]],
  ["OMNI_SECURITY_PUBLIC_PATHS", ["security", "publicPaths"]],
  ["OMNI_ROUTING_ALLOWED_MODELS", ["routing", "allowedModels"]],
  ["OMNI_ROUTING_RULES", ["routing", "rules"]],
  ["OMNI_RATE_LIMITS", ["rateLimits"]],
];

/** Per-backend shortcuts, applied after JSON blocks and before generic overrides. */
const STORAGE_VALUES: ReadonlyArray<readonly [name: string, field: string]> = [
  ["OMNI_STORAGE_POSTGRES_URL", "url"],
  ["OMNI_STORAGE_POSTGRES_MIGRATE", "migrate"],
];

/**
 * Shortcuts for the single-upstream deployment, seeding one catch-all rule.
 *
 * The overwhelmingly common first boot is "one provider, one key, send everything
 * there". Expressing that as `OMNI_ROUTING_RULES='[{...}]'` would make the
 * simplest case the ugliest, so these build the rule instead: `when: "true"` with
 * one target. Anything more — several upstreams, conditions on claims — is
 * `OMNI_ROUTING_RULES`, or the admin API.
 */
const TARGET_VALUES: ReadonlyArray<readonly [name: string, field: string]> = [
  ["OMNI_TARGET_TYPE", "type"],
  ["OMNI_TARGET_MODEL", "model"],
  ["OMNI_TARGET_API_KEY", "apiKey"],
  ["OMNI_TARGET_BASE_URL", "baseUrl"],
  ["OMNI_TARGET_ORGANIZATION", "organization"],
  ["OMNI_TARGET_HEADERS", "headers"],
  ["OMNI_TARGET_MODELS", "models"],
  ["OMNI_TARGET_INCLUDE_STREAM_USAGE", "includeStreamUsage"],
  ["OMNI_TARGET_ANTHROPIC_VERSION", "version"],
  ["OMNI_TARGET_ANTHROPIC_MAX_TOKENS_DEFAULT", "maxTokensDefault"],
];

interface SecurityProfile {
  readonly type: string;
  readonly enabled: string;
  readonly values: ReadonlyArray<readonly [name: string, field: string]>;
  readonly appId?: string;
  readonly appIds?: string;
}

/** Built-in security verifiers exposed as easy-to-discover environment profiles. */
const SECURITY_PROFILES: readonly SecurityProfile[] = [
  {
    type: "firebase-auth",
    enabled: "OMNI_SECURITY_FIREBASE_AUTH_ENABLED",
    values: [
      ["OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID", "projectId"],
      ["OMNI_SECURITY_FIREBASE_AUTH_HEADER", "header"],
      ["OMNI_SECURITY_FIREBASE_AUTH_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "firebase-app-check",
    enabled: "OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED",
    values: [
      ["OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER", "projectNumber"],
      ["OMNI_SECURITY_FIREBASE_APPCHECK_HEADER", "header"],
      ["OMNI_SECURITY_FIREBASE_APPCHECK_CONSUME", "consume"],
      ["OMNI_SECURITY_FIREBASE_APPCHECK_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
    appId: "OMNI_SECURITY_FIREBASE_APPCHECK_APP_ID",
    appIds: "OMNI_SECURITY_FIREBASE_APPCHECK_APP_IDS",
  },
  {
    type: "jwt",
    enabled: "OMNI_SECURITY_JWT_ENABLED",
    values: [
      ["OMNI_SECURITY_JWT_SECRET", "secret"],
      ["OMNI_SECURITY_JWT_JWKS_URL", "jwksUrl"],
      ["OMNI_SECURITY_JWT_PUBLIC_KEY", "publicKey"],
      ["OMNI_SECURITY_JWT_ALGORITHMS", "algorithms"],
      ["OMNI_SECURITY_JWT_ISSUER", "issuer"],
      ["OMNI_SECURITY_JWT_AUDIENCE", "audience"],
      ["OMNI_SECURITY_JWT_HEADER", "header"],
      ["OMNI_SECURITY_JWT_SCHEME", "scheme"],
      ["OMNI_SECURITY_JWT_USER_ID_CLAIM", "userIdClaim"],
      ["OMNI_SECURITY_JWT_DEVICE_ID_CLAIM", "deviceIdClaim"],
      ["OMNI_SECURITY_JWT_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "supabase",
    enabled: "OMNI_SECURITY_SUPABASE_ENABLED",
    values: [
      ["OMNI_SECURITY_SUPABASE_URL", "url"],
      ["OMNI_SECURITY_SUPABASE_JWT_SECRET", "jwtSecret"],
      ["OMNI_SECURITY_SUPABASE_JWKS_URL", "jwksUrl"],
      ["OMNI_SECURITY_SUPABASE_ISSUER", "issuer"],
      ["OMNI_SECURITY_SUPABASE_AUDIENCE", "audience"],
      ["OMNI_SECURITY_SUPABASE_HEADER", "header"],
      ["OMNI_SECURITY_SUPABASE_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "apple-app-attest",
    enabled: "OMNI_SECURITY_APP_ATTEST_ENABLED",
    values: [
      ["OMNI_SECURITY_APP_ATTEST_TEAM_ID", "teamId"],
      ["OMNI_SECURITY_APP_ATTEST_BUNDLE_ID", "bundleId"],
      ["OMNI_SECURITY_APP_ATTEST_ENVIRONMENT", "environment"],
      ["OMNI_SECURITY_APP_ATTEST_CHALLENGE_TTL", "challengeTtl"],
      ["OMNI_SECURITY_APP_ATTEST_ROOT_CA_PEM", "rootCaPem"],
      ["OMNI_SECURITY_APP_ATTEST_KEY_ID_HEADER", "keyIdHeader"],
      ["OMNI_SECURITY_APP_ATTEST_ASSERTION_HEADER", "assertionHeader"],
      ["OMNI_SECURITY_APP_ATTEST_CHALLENGE_HEADER", "challengeHeader"],
    ],
  },
  {
    type: "apple-device-check",
    enabled: "OMNI_SECURITY_DEVICE_CHECK_ENABLED",
    values: [
      ["OMNI_SECURITY_DEVICE_CHECK_TEAM_ID", "teamId"],
      ["OMNI_SECURITY_DEVICE_CHECK_KEY_ID", "keyId"],
      ["OMNI_SECURITY_DEVICE_CHECK_PRIVATE_KEY", "privateKey"],
      ["OMNI_SECURITY_DEVICE_CHECK_DEVELOPMENT", "development"],
      ["OMNI_SECURITY_DEVICE_CHECK_HEADER", "header"],
      ["OMNI_SECURITY_DEVICE_CHECK_CACHE_TTL", "cacheTtl"],
    ],
  },
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

function applyObjectValues(
  target: Record<string, unknown>,
  env: Record<string, string | undefined>,
  values: ReadonlyArray<readonly [name: string, field: string]>,
): boolean {
  let applied = false;
  for (const [name, field] of values) {
    const value = env[name];
    if (value === undefined) continue;
    target[field] = shortcutValue(value, name);
    applied = true;
  }
  return applied;
}

function shortcutValue(value: string, key: string): unknown {
  const typedValue =
    key.endsWith("_MIGRATE") ||
    key.endsWith("_CONSUME") ||
    key.endsWith("_INCLUDE_STREAM_USAGE") ||
    key.endsWith("_MAX_TOKENS_DEFAULT") ||
    key.endsWith("_CLOCK_TOLERANCE_SECONDS") ||
    key.endsWith("_DEVELOPMENT") ||
    key.endsWith("_HEADERS") ||
    key.endsWith("_MODELS") ||
    key.endsWith("_ALGORITHMS") ||
    key.endsWith("_AUDIENCE") ||
    key.endsWith("_APP_IDS");
  return typedValue ? parseEnvironmentValue(value, key) : value;
}

function storageDocument(root: Record<string, unknown>): Record<string, unknown> {
  const existing = root.storage;
  if (existing === undefined) {
    const storage: Record<string, unknown> = {};
    root.storage = storage;
    return storage;
  }
  if (isObject(existing) === false) {
    throw new ConfigError("storage shortcuts conflict with a non-object storage configuration");
  }
  return existing;
}

function applyStorageValues(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  if (STORAGE_VALUES.some(([name]) => env[name] !== undefined) === false) return;
  const storage = storageDocument(root);
  applyObjectValues(storage, env, STORAGE_VALUES);
}

/**
 * The catch-all rule the target shortcuts fill in, created on first use.
 *
 * Reuses an existing `routing.rules[0]` when one is already there, so a JSON
 * block plus a shortcut compose the way every other shortcut in this file does.
 */
function catchAllTarget(root: Record<string, unknown>): Record<string, unknown> {
  const existingRouting = root.routing;
  let routing: Record<string, unknown>;
  if (existingRouting === undefined) {
    routing = {};
    root.routing = routing;
  } else if (isObject(existingRouting)) {
    routing = existingRouting;
  } else {
    throw new ConfigError("OMNI_TARGET_* conflicts with a non-object routing configuration");
  }

  const existingRules = routing.rules;
  let rules: unknown[];
  if (existingRules === undefined) {
    rules = [];
    routing.rules = rules;
  } else if (Array.isArray(existingRules)) {
    rules = existingRules;
  } else {
    throw new ConfigError("OMNI_TARGET_* conflicts with a non-array routing.rules");
  }

  if (rules.length === 0) {
    const target: Record<string, unknown> = {};
    rules.push({ id: "default", when: "true", target });
    return target;
  }
  const first = rules[0];
  if (isObject(first) === false) {
    throw new ConfigError("OMNI_TARGET_* conflicts with routing.rules[0]");
  }
  const existingTarget = first.target;
  if (existingTarget === undefined) {
    const target: Record<string, unknown> = {};
    first.target = target;
    return target;
  }
  if (isObject(existingTarget) === false) {
    throw new ConfigError("OMNI_TARGET_* conflicts with routing.rules[0].target");
  }
  return existingTarget;
}

function applyTargetValues(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  if (TARGET_VALUES.some(([name]) => env[name] !== undefined) === false) return;

  const target = catchAllTarget(root);
  for (const [name, field] of TARGET_VALUES) {
    const value = env[name];
    // An empty compatible-provider API key means "no API key" rather than an
    // invalid empty credential; a platform's optional form field submits "".
    if (value === undefined || (name === "OMNI_TARGET_API_KEY" && value.trim() === "")) {
      continue;
    }
    target[field] = shortcutValue(value, name);
  }
}

function requiredBoolean(value: string, key: string): boolean {
  const parsed = parseEnvironmentValue(value, key);
  if (typeof parsed !== "boolean") {
    throw new ConfigError(`${key}: expected true or false`);
  }
  return parsed;
}

function securityProvidersDocument(root: Record<string, unknown>): unknown[] {
  const existingSecurity = root.security;
  let security: Record<string, unknown>;
  if (existingSecurity === undefined) {
    security = {};
    root.security = security;
  } else if (isObject(existingSecurity)) {
    security = existingSecurity;
  } else {
    throw new ConfigError("security shortcuts conflict with a non-object security configuration");
  }

  const existingProviders = security.providers;
  if (existingProviders === undefined) {
    const providers: unknown[] = [];
    security.providers = providers;
    return providers;
  }
  if (Array.isArray(existingProviders) === false) {
    throw new ConfigError(
      "security shortcuts conflict with a non-array security.providers configuration",
    );
  }
  return existingProviders;
}

function applySecurityProfiles(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  for (const profile of SECURITY_PROFILES) {
    const enabled = env[profile.enabled];
    if (enabled === undefined || requiredBoolean(enabled, profile.enabled) === false) continue;

    const provider: Record<string, unknown> = { type: profile.type };
    applyObjectValues(provider, env, profile.values);
    if (profile.appId !== undefined) {
      const appId = env[profile.appId];
      if (appId !== undefined && appId.trim() !== "") provider.appIds = [appId];
    }
    if (profile.appIds !== undefined) {
      const appIds = env[profile.appIds];
      if (appIds !== undefined && appIds.trim() !== "") {
        provider.appIds = parseEnvironmentValue(appIds, profile.appIds);
      }
    }

    const providers = securityProvidersDocument(root);
    const index = providers.findIndex(
      (existing) => isObject(existing) && existing.type === profile.type,
    );
    if (index === -1) {
      providers.push(provider);
    } else {
      providers[index] = mergeConfigValue(providers[index], provider);
    }
  }
}

function isEnvironmentConfigKey(key: string): boolean {
  return (
    key.startsWith(ENV_CONFIG_PREFIX) ||
    JSON_BLOCKS.some(([name]) => name === key) ||
    SIMPLE_VALUES.some(([name]) => name === key) ||
    STORAGE_VALUES.some(([name]) => name === key) ||
    TARGET_VALUES.some(([name]) => name === key) ||
    SECURITY_PROFILES.some(
      (profile) =>
        profile.enabled === key ||
        profile.values.some(([name]) => name === key) ||
        profile.appId === key ||
        profile.appIds === key,
    )
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
 * accept complex sections. Named storage, default-provider, and security
 * profile variables provide an easy setup surface; simple variables and
 * `OMNI__...` paths then override those blocks. Double underscores separate
 * object keys and numeric segments create array entries. SCREAMING_SNAKE_CASE
 * segments are converted to lowerCamelCase, so
 * `OMNI__SERVER__MAX_BODY_BYTES=3000000` becomes `server.maxBodyBytes: 3000000`.
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
      "no environment configuration found; set named variables such as OMNI_STORAGE_TYPE, " +
        "OMNI_SECURITY_JWT_ENABLED, and OMNI_PROVIDERS_DEFAULT_TYPE, or use OMNI_CONFIG_JSON",
    );
  }

  const document: Record<string, unknown> = {};
  for (const [name, path] of JSON_BLOCKS) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      applyBlock(document, path, parseJsonBlock(value, name), name);
    }
  }
  applyStorageValues(document, env);
  applyTargetValues(document, env);
  applySecurityProfiles(document, env);
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
