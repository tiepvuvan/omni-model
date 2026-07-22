import { type OmniConfig, omniConfigSchema, parseConfigObject } from "@omni-model/core";

/**
 * The three upstream providers this extension can wire up, keyed by the env var
 * that carries the API key and paired with the routing id / provider `type`
 * used in the generated config.
 */
const PROVIDER_KEYS = [
  { env: "OPENAI_API_KEY", id: "openai", type: "openai" },
  { env: "ANTHROPIC_API_KEY", id: "anthropic", type: "anthropic" },
  { env: "GEMINI_API_KEY", id: "google", type: "google" },
] as const;

/** Map a `DEFAULT_PROVIDER` select value to the routing id used in the config. */
const DEFAULT_PROVIDER_TO_ID: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
};

/**
 * Parse a positive-integer extension param. The values arrive as strings (the
 * extension param system has no numeric type), so a malformed value is a
 * configuration mistake that must fail fast at startup, never mid-request.
 */
function parseIntParam(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`omni-model-proxy: ${name} must be a non-negative integer (got "${value}")`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`omni-model-proxy: ${name} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

/**
 * Build the {@link OmniConfig} for this extension instance from its runtime
 * environment (the params are mounted as env vars named after their param id).
 *
 * If `ADVANCED_CONFIG_JSON` is provided, it is treated as a full JSON
 * configuration override (with `${ENV}` interpolation against the same env).
 * Otherwise a config is assembled from the individual params: one provider per
 * API key that is present, a Firestore-backed rate limiter, and per-user
 * request + daily-token budgets. Validation goes through `omniConfigSchema` so
 * a bad combination throws at startup.
 */
export function buildOmniConfig(env: NodeJS.ProcessEnv): OmniConfig {
  const advanced = env.ADVANCED_CONFIG_JSON?.trim();
  if (advanced !== undefined && advanced !== "") {
    let document: unknown;
    try {
      document = JSON.parse(advanced);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`omni-model-proxy: ADVANCED_CONFIG_JSON must be valid JSON (${message})`);
    }
    return parseConfigObject(document, env);
  }

  const providers: Record<string, { type: string; apiKey: string }> = {};
  for (const { env: keyEnv, id, type } of PROVIDER_KEYS) {
    const apiKey = env[keyEnv]?.trim();
    if (apiKey !== undefined && apiKey !== "") {
      providers[id] = { type, apiKey };
    }
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      "omni-model-proxy: no provider API key configured — set at least one of " +
        "OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY (or provide ADVANCED_CONFIG_JSON).",
    );
  }

  // Prefer the selected default provider, but only if its key is configured;
  // otherwise fall back to whichever provider was configured first.
  const requestedDefault = DEFAULT_PROVIDER_TO_ID[env.DEFAULT_PROVIDER?.trim() ?? "openai"];
  const defaultProvider =
    requestedDefault !== undefined && requestedDefault in providers
      ? requestedDefault
      : (Object.keys(providers)[0] as string);

  // Keep reading the former minute-named parameter so existing extension
  // instances remain valid after upgrading; it now uses the stricter hour window.
  const requestsPerHour = parseIntParam(
    "REQUESTS_PER_HOUR",
    env.REQUESTS_PER_HOUR ?? env.REQUESTS_PER_MINUTE,
    30,
  );
  const dailyTokenBudget = parseIntParam("DAILY_TOKEN_BUDGET", env.DAILY_TOKEN_BUDGET, 30_000);
  const collection = env.FIRESTORE_COLLECTION?.trim() || "omni_ratelimits";

  return omniConfigSchema.parse({
    version: 1,
    storage: { type: "firestore", collection },
    // Callable requests are authenticated by the Firebase callable protocol
    // (Auth + App Check), so no in-pipeline security providers are needed.
    security: { providers: [] },
    rateLimits: [
      {
        name: "per-user-requests",
        key: "user",
        requests: { limit: requestsPerHour, window: "1h" },
      },
      {
        name: "per-user-daily-tokens",
        key: "user",
        tokens: { limit: dailyTokenBudget, window: "1d" },
      },
    ],
    providers,
    routing: { defaultProvider },
  });
}
