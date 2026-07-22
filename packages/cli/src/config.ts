import type { StorageId, TargetId } from "./targets.js";

/**
 * Turns the wizard's answers into environment configuration blocks.
 *
 * Pure and dependency-free on purpose: this is the piece worth testing, and the
 * test asserts every combination it can produce parses against the real schema
 * in @omni-model/core.
 *
 * **Secrets are never written here.** Provider keys and the Apple .p8 are
 * emitted as `${ENV}` references, which the proxy interpolates at startup.
 */

export type ProviderId = "openai" | "anthropic" | "google" | "openai-compatible";

export interface ProviderChoice {
  id: ProviderId;
  /** Key under `providers:` in the config, e.g. "openai". */
  name: string;
  /** Env var the apiKey references, e.g. OPENAI_API_KEY. */
  envVar: string;
  /** Only for openai-compatible (OpenRouter, Groq, Together, ...). */
  baseUrl?: string;
}

export type AuthId =
  | "firebase-auth"
  | "firebase-app-check"
  | "apple-app-attest"
  | "apple-device-check";

export interface Answers {
  target: TargetId;
  storage: StorageId;
  provider: ProviderChoice;
  auth: AuthId[];
  /** Firebase project id / number, when a Firebase verifier is selected. */
  firebaseProjectId?: string;
  firebaseProjectNumber?: string;
  /** Apple team + bundle, when an Apple verifier is selected. */
  appleTeamId?: string;
  appleBundleId?: string;
  /** Requests per minute per identity. 0/undefined disables the rule. */
  requestsPerMinute?: number;
  /** Daily token budget per identity. 0/undefined disables the rule. */
  tokensPerDay?: number;
}

/**
 * An environment reference for the proxy to resolve at startup — the `${NAME}`
 * syntax of the config format, not a JS template placeholder. Built through a
 * helper so it reads as the domain concept it is, and so help text renders the
 * same reference the config actually emits.
 */
export function envRef(name: string): string {
  return `\${${name}}`;
}

/** The `storage:` block for a backend, including the env refs it needs. */
function storageBlock(storage: StorageId): Record<string, unknown> {
  switch (storage) {
    case "durable-object":
      return { type: "durable-object", binding: "OMNI_DO" };
    case "cloudflare-kv":
      return { type: "cloudflare-kv", binding: "OMNI_KV" };
    case "firestore":
      return { type: "firestore", collection: "omni_ratelimits" };
    case "redis":
      return { type: "redis", url: envRef("REDIS_URL") };
    case "postgres":
      return { type: "postgres", url: envRef("DATABASE_URL") };
    case "memory":
      return { type: "memory" };
  }
}

function providerBlock(p: ProviderChoice): Record<string, unknown> {
  const block: Record<string, unknown> = { type: p.id, apiKey: envRef(p.envVar) };
  if (p.id === "openai-compatible" && p.baseUrl !== undefined) block.baseUrl = p.baseUrl;
  return block;
}

/** The `security.providers[]` entry for one verifier. */
function securityProvider(id: AuthId, a: Answers): Record<string, unknown> {
  switch (id) {
    case "firebase-auth":
      return { type: id, projectId: a.firebaseProjectId ?? envRef("FIREBASE_PROJECT_ID") };
    case "firebase-app-check":
      return {
        type: id,
        projectNumber: a.firebaseProjectNumber ?? envRef("FIREBASE_PROJECT_NUMBER"),
      };
    case "apple-app-attest":
      return {
        type: id,
        teamId: a.appleTeamId ?? envRef("APPLE_TEAM_ID"),
        bundleId: a.appleBundleId ?? envRef("APPLE_BUNDLE_ID"),
        // A debug build run from Xcode produces development attestations;
        // flip to production for TestFlight/App Store builds.
        environment: "development",
      };
    case "apple-device-check":
      return {
        type: id,
        teamId: a.appleTeamId ?? envRef("APPLE_TEAM_ID"),
        keyId: envRef("APPLE_DEVICECHECK_KEY_ID"),
        // The .p8 contents — a real secret, so it is never written here.
        privateKey: envRef("APPLE_DEVICECHECK_KEY"),
        development: true,
      };
  }
}

function securityProviders(a: Answers): Record<string, unknown>[] {
  return a.auth.map((id) => securityProvider(id, a));
}

function rateLimits(a: Answers): Record<string, unknown>[] {
  // A verifier is always configured, so there is always an identity to key on.
  const key = "user";
  const rules: Record<string, unknown>[] = [];
  if (a.requestsPerMinute && a.requestsPerMinute > 0) {
    rules.push({
      name: "requests",
      key,
      requests: { limit: a.requestsPerMinute, window: "1m" },
    });
  }
  if (a.tokensPerDay && a.tokensPerDay > 0) {
    rules.push({ name: "tokens", key, tokens: { limit: a.tokensPerDay, window: "1d" } });
  }
  return rules;
}

/** Build the config document (plain data — stringify separately). */
export function buildConfig(a: Answers): Record<string, unknown> {
  return {
    version: 1,
    storage: storageBlock(a.storage),
    // At least one verifier is mandatory — the proxy refuses to start without
    // one, so the wizard and --auth both require a choice.
    security: { mode: "all", providers: securityProviders(a) },
    rateLimits: rateLimits(a),
    providers: { [a.provider.name]: providerBlock(a.provider) },
    routing: { defaultProvider: a.provider.name },
  };
}

/** Environment variables for the generated one-provider configuration. */
export function configEnvironment(a: Answers): Record<string, string> {
  const storage: Record<StorageId, Record<string, string>> = {
    "durable-object": {
      OMNI_STORAGE_TYPE: "durable-object",
      OMNI_STORAGE_DURABLE_OBJECT_BINDING: "OMNI_DO",
    },
    "cloudflare-kv": {
      OMNI_STORAGE_TYPE: "cloudflare-kv",
      OMNI_STORAGE_CLOUDFLARE_KV_BINDING: "OMNI_KV",
    },
    firestore: {
      OMNI_STORAGE_TYPE: "firestore",
      OMNI_STORAGE_FIRESTORE_COLLECTION: "omni_ratelimits",
    },
    redis: { OMNI_STORAGE_TYPE: "redis", OMNI_STORAGE_REDIS_URL: envRef("REDIS_URL") },
    postgres: {
      OMNI_STORAGE_TYPE: "postgres",
      OMNI_STORAGE_POSTGRES_URL: envRef("DATABASE_URL"),
    },
    memory: { OMNI_STORAGE_TYPE: "memory" },
  };
  const provider: Record<string, string> = {
    OMNI_PROVIDERS_DEFAULT_TYPE: a.provider.id,
    OMNI_PROVIDERS_DEFAULT_API_KEY: envRef(a.provider.envVar),
  };
  if (a.provider.baseUrl !== undefined) {
    provider.OMNI_PROVIDERS_DEFAULT_BASE_URL = a.provider.baseUrl;
  }

  const security: Record<string, string> = { OMNI_SECURITY_MODE: "all" };
  for (const id of a.auth) {
    switch (id) {
      case "firebase-auth":
        security.OMNI_SECURITY_FIREBASE_AUTH_ENABLED = "true";
        security.OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID =
          a.firebaseProjectId ?? envRef("FIREBASE_PROJECT_ID");
        break;
      case "firebase-app-check":
        security.OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED = "true";
        security.OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER =
          a.firebaseProjectNumber ?? envRef("FIREBASE_PROJECT_NUMBER");
        break;
      case "apple-app-attest":
        security.OMNI_SECURITY_APP_ATTEST_ENABLED = "true";
        security.OMNI_SECURITY_APP_ATTEST_TEAM_ID = a.appleTeamId ?? envRef("APPLE_TEAM_ID");
        security.OMNI_SECURITY_APP_ATTEST_BUNDLE_ID = a.appleBundleId ?? envRef("APPLE_BUNDLE_ID");
        security.OMNI_SECURITY_APP_ATTEST_ENVIRONMENT = "development";
        break;
      case "apple-device-check":
        security.OMNI_SECURITY_DEVICE_CHECK_ENABLED = "true";
        security.OMNI_SECURITY_DEVICE_CHECK_TEAM_ID = a.appleTeamId ?? envRef("APPLE_TEAM_ID");
        security.OMNI_SECURITY_DEVICE_CHECK_KEY_ID = envRef("APPLE_DEVICECHECK_KEY_ID");
        security.OMNI_SECURITY_DEVICE_CHECK_PRIVATE_KEY = envRef("APPLE_DEVICECHECK_KEY");
        security.OMNI_SECURITY_DEVICE_CHECK_DEVELOPMENT = "true";
        break;
    }
  }

  return {
    ...storage[a.storage],
    ...security,
    OMNI_RATE_LIMITS_JSON: JSON.stringify(rateLimits(a)),
    ...provider,
  };
}

/** A `.env`-compatible rendering of {@link configEnvironment}. */
export function toEnv(a: Answers): string {
  return Object.entries(configEnvironment(a))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n");
}

/** Every `${VAR}` the generated config references — what the user must set. */
export function envVarsFor(a: Answers): string[] {
  const vars = new Set<string>([a.provider.envVar]);
  if (a.storage === "redis") vars.add("REDIS_URL");
  if (a.storage === "postgres") vars.add("DATABASE_URL");
  for (const id of a.auth) {
    if (id === "firebase-auth" && !a.firebaseProjectId) vars.add("FIREBASE_PROJECT_ID");
    if (id === "firebase-app-check" && !a.firebaseProjectNumber)
      vars.add("FIREBASE_PROJECT_NUMBER");
    if (id === "apple-app-attest" || id === "apple-device-check") {
      if (!a.appleTeamId) vars.add("APPLE_TEAM_ID");
      if (id === "apple-app-attest" && !a.appleBundleId) vars.add("APPLE_BUNDLE_ID");
      if (id === "apple-device-check") {
        vars.add("APPLE_DEVICECHECK_KEY_ID");
        vars.add("APPLE_DEVICECHECK_KEY");
      }
    }
  }
  return [...vars];
}
