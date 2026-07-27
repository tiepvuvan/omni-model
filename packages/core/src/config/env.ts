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
  ["OMNI_SECURITY_USER_AUTH_JSON", ["security", "userAuth"]],
  ["OMNI_SECURITY_APP_AUTH_JSON", ["security", "appAuth"]],
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
  ["OMNI_SERVER_MAX_INPUT_TOKENS", ["server", "maxInputTokens"]],
  ["OMNI_SERVER_CORS", ["server", "cors"]],
  ["OMNI_STORAGE_TYPE", ["storage", "type"]],
  ["OMNI_SECURITY_APP_AUTH_MODE", ["security", "appAuth", "mode"]],
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
  /**
   * Which half of `security` this profile writes to.
   *
   * A copy of the factory's own `layer`, because this module maps environment
   * variables and cannot reach the registry without a cycle. `env.test.ts` asserts
   * the two agree, so a new verifier cannot land here in the wrong half.
   */
  readonly layer: "user" | "app";
  readonly enabled: string;
  readonly values: ReadonlyArray<readonly [name: string, field: string]>;
  readonly appId?: string;
  readonly appIds?: string;
}

/** Built-in security verifiers exposed as easy-to-discover environment profiles. */
const SECURITY_PROFILES: readonly SecurityProfile[] = [
  {
    type: "clerk",
    layer: "user",
    enabled: "OMNI_SECURITY_CLERK_ENABLED",
    values: [
      ["OMNI_SECURITY_CLERK_ISSUER", "issuer"],
      ["OMNI_SECURITY_CLERK_JWKS_URL", "jwksUrl"],
      ["OMNI_SECURITY_CLERK_AUTHORIZED_PARTIES", "authorizedParties"],
      ["OMNI_SECURITY_CLERK_AUDIENCE", "audience"],
      ["OMNI_SECURITY_CLERK_ALLOW_PENDING_SESSIONS", "allowPendingSessions"],
      ["OMNI_SECURITY_CLERK_HEADER", "header"],
      ["OMNI_SECURITY_CLERK_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "aws-cognito",
    layer: "user",
    enabled: "OMNI_SECURITY_AWS_COGNITO_ENABLED",
    values: [
      ["OMNI_SECURITY_AWS_COGNITO_REGION", "region"],
      ["OMNI_SECURITY_AWS_COGNITO_USER_POOL_ID", "userPoolId"],
      ["OMNI_SECURITY_AWS_COGNITO_CLIENT_IDS", "clientIds"],
      ["OMNI_SECURITY_AWS_COGNITO_TOKEN_USE", "tokenUse"],
      ["OMNI_SECURITY_AWS_COGNITO_REQUIRED_SCOPES", "requiredScopes"],
      ["OMNI_SECURITY_AWS_COGNITO_HEADER", "header"],
      ["OMNI_SECURITY_AWS_COGNITO_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "firebase-auth",
    layer: "user",
    enabled: "OMNI_SECURITY_FIREBASE_AUTH_ENABLED",
    values: [
      ["OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID", "projectId"],
      ["OMNI_SECURITY_FIREBASE_AUTH_HEADER", "header"],
      ["OMNI_SECURITY_FIREBASE_AUTH_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
    ],
  },
  {
    type: "firebase-app-check",
    layer: "app",
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
    type: "cloudflare-turnstile",
    layer: "app",
    enabled: "OMNI_SECURITY_CLOUDFLARE_TURNSTILE_ENABLED",
    values: [
      ["OMNI_SECURITY_CLOUDFLARE_TURNSTILE_SECRET", "secret"],
      ["OMNI_SECURITY_CLOUDFLARE_TURNSTILE_HEADER", "header"],
      ["OMNI_SECURITY_CLOUDFLARE_TURNSTILE_ACTION", "action"],
      ["OMNI_SECURITY_CLOUDFLARE_TURNSTILE_HOSTNAMES", "hostnames"],
    ],
  },
  {
    type: "recaptcha-enterprise",
    layer: "app",
    enabled: "OMNI_SECURITY_RECAPTCHA_ENTERPRISE_ENABLED",
    values: [
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_PROJECT_ID", "projectId"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_SITE_KEY", "siteKey"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_API_KEY", "apiKey"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_SERVICE_ACCOUNT_KEY", "serviceAccountKey"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_EXPECTED_ACTION", "expectedAction"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_MIN_SCORE", "minScore"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_HEADER", "header"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_HOSTNAMES", "hostnames"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_ANDROID_PACKAGE_NAMES", "androidPackageNames"],
      ["OMNI_SECURITY_RECAPTCHA_ENTERPRISE_IOS_BUNDLE_IDS", "iosBundleIds"],
    ],
  },
  {
    type: "google-play-integrity",
    layer: "app",
    enabled: "OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_ENABLED",
    values: [
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME", "packageName"],
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY", "serviceAccountKey"],
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_HEADER", "header"],
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_MAX_AGE", "maxAge"],
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_CLOCK_TOLERANCE_SECONDS", "clockToleranceSeconds"],
      [
        "OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_DEVICE_RECOGNITION_VERDICTS",
        "deviceRecognitionVerdicts",
      ],
      ["OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_REQUIRE_LICENSED", "requireLicensed"],
      [
        "OMNI_SECURITY_GOOGLE_PLAY_INTEGRITY_CERTIFICATE_SHA256_DIGESTS",
        "certificateSha256Digests",
      ],
    ],
  },
  {
    type: "jwt",
    layer: "user",
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
    layer: "user",
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
    layer: "app",
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
    layer: "app",
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
    key.endsWith("_APP_IDS") ||
    key.endsWith("_MIN_SCORE") ||
    key.endsWith("_REQUIRE_LICENSED") ||
    key.endsWith("_HOSTNAMES") ||
    key.endsWith("_ANDROID_PACKAGE_NAMES") ||
    key.endsWith("_IOS_BUNDLE_IDS") ||
    key.endsWith("_DEVICE_RECOGNITION_VERDICTS") ||
    key.endsWith("_CERTIFICATE_SHA256_DIGESTS") ||
    key.endsWith("_AUTHORIZED_PARTIES") ||
    key.endsWith("_ALLOW_PENDING_SESSIONS") ||
    key.endsWith("_CLIENT_IDS") ||
    key.endsWith("_REQUIRED_SCOPES");
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

/** The `security` object out of the document under construction. */
function securityDocument(root: Record<string, unknown>): Record<string, unknown> {
  const existing = root.security;
  if (existing === undefined) {
    const security: Record<string, unknown> = {};
    root.security = security;
    return security;
  }
  if (isObject(existing)) return existing;
  throw new ConfigError("security shortcuts conflict with a non-object security configuration");
}

/** The `security.appAuth.providers` array, created on demand. */
function appAuthProvidersDocument(root: Record<string, unknown>): unknown[] {
  const security = securityDocument(root);
  const existingAppAuth = security.appAuth;
  let appAuth: Record<string, unknown>;
  if (existingAppAuth === undefined) {
    appAuth = {};
    security.appAuth = appAuth;
  } else if (isObject(existingAppAuth)) {
    appAuth = existingAppAuth;
  } else {
    throw new ConfigError(
      "security shortcuts conflict with a non-object security.appAuth configuration",
    );
  }

  const existing = appAuth.providers;
  if (existing === undefined) {
    const providers: unknown[] = [];
    appAuth.providers = providers;
    return providers;
  }
  if (Array.isArray(existing) === false) {
    throw new ConfigError(
      "security shortcuts conflict with a non-array security.appAuth.providers configuration",
    );
  }
  return existing;
}

function applySecurityProfiles(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  let userProfile: SecurityProfile | null = null;

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

    if (profile.layer === "user") {
      // Two user methods is a question with no answer — which one owns `user.id`,
      // and so whose token budget a request spends. Refusing beats picking.
      if (userProfile !== null && userProfile.type !== profile.type) {
        throw new ConfigError(
          `${userProfile.enabled} and ${profile.enabled} are both set: a deployment has exactly ` +
            "one user authentication method. Enable one of them.",
        );
      }
      userProfile = profile;
      const security = securityDocument(root);
      const existing = security.userAuth;
      security.userAuth = isObject(existing) ? mergeConfigValue(existing, provider) : provider;
      continue;
    }

    const providers = appAuthProvidersDocument(root);
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
 * `OMNI__SERVER__MAX_INPUT_TOKENS=128000` becomes `server.maxInputTokens: 128000`.
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
