import type { Answers, AuthId, ProviderChoice, ProviderId } from "./config.js";
import { STORAGE, type StorageId, storagesFor, TARGETS, type TargetId } from "./targets.js";

/**
 * Non-interactive mode: turn command-line flags into the same `Answers` the
 * wizard produces.
 *
 * Pure and total — every failure is a `FlagError` naming the valid values, so
 * `omni-model deploy --target cloudflare --storage firestore` tells you
 * Cloudflare can't run Firestore instead of emitting a config that dies on the
 * first request. This is also what makes non-interactive mode testable: the
 * prompts can't be driven from CI, but this can.
 */

export class FlagError extends Error {}

export interface DeployFlags {
  target?: string;
  storage?: string;
  provider?: string;
  providerName?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Comma-separated verifier list, or "none" for an open proxy. */
  auth?: string;
  firebaseProjectId?: string;
  firebaseProjectNumber?: string;
  appleTeamId?: string;
  appleBundleId?: string;
  requestsPerMinute?: string;
  tokensPerDay?: string;
}

const PROVIDER_IDS: ProviderId[] = ["openai", "anthropic", "google", "openai-compatible"];
const AUTH_IDS: AuthId[] = [
  "firebase-auth",
  "firebase-app-check",
  "apple-app-attest",
  "apple-device-check",
];

const DEFAULT_KEY_ENV: Record<ProviderId, string | undefined> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  // Derived from the provider name, e.g. openrouter -> OPENROUTER_API_KEY.
  "openai-compatible": undefined,
};

function oneOf<T extends string>(value: string, valid: readonly T[], what: string): T {
  if (!(valid as readonly string[]).includes(value)) {
    throw new FlagError(`unknown ${what} "${value}" — valid: ${valid.join(", ")}`);
  }
  return value as T;
}

function wholeNumber(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new FlagError(`${flag} must be a whole number, got "${value}"`);
  return Number(value);
}

/** True when the user supplied enough to skip the wizard entirely. */
export function hasFlags(f: DeployFlags): boolean {
  return f.target !== undefined;
}

/** Build `Answers` from flags, or throw a `FlagError` explaining what's wrong. */
export function answersFromFlags(f: DeployFlags): Answers {
  if (f.target === undefined) {
    throw new FlagError(
      `--target is required in non-interactive mode — one of: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  const target = oneOf<TargetId>(f.target, Object.keys(TARGETS) as TargetId[], "target");

  const allowed = storagesFor(target).map((s) => s.id);
  const storage: StorageId =
    f.storage === undefined
      ? (allowed[0] as StorageId)
      : oneOf<StorageId>(f.storage, Object.keys(STORAGE) as StorageId[], "storage");
  if (!allowed.includes(storage)) {
    throw new FlagError(
      `storage "${storage}" isn't available on ${TARGETS[target].label} — valid: ${allowed.join(", ")}`,
    );
  }

  const providerId = oneOf<ProviderId>(f.provider ?? "openai", PROVIDER_IDS, "provider");
  const providerName =
    f.providerName ?? (providerId === "openai-compatible" ? "custom" : providerId);
  if (!/^[a-z0-9-]+$/.test(providerName)) {
    throw new FlagError(
      `--provider-name must be lowercase letters, digits and -, got "${providerName}"`,
    );
  }
  if (providerId === "openai-compatible" && f.baseUrl === undefined) {
    throw new FlagError("--base-url is required when --provider openai-compatible");
  }
  if (f.baseUrl !== undefined && !/^https?:\/\//.test(f.baseUrl)) {
    throw new FlagError(`--base-url must be an http(s) URL, got "${f.baseUrl}"`);
  }
  const envVar =
    f.apiKeyEnv ??
    DEFAULT_KEY_ENV[providerId] ??
    `${providerName.replace(/-/g, "_").toUpperCase()}_API_KEY`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) {
    throw new FlagError(`--api-key-env must be UPPER_SNAKE_CASE, got "${envVar}"`);
  }

  const provider: ProviderChoice = { id: providerId, name: providerName, envVar };
  if (f.baseUrl !== undefined) provider.baseUrl = f.baseUrl;

  // Deliberately required: defaulting to no auth would silently publish an open
  // proxy that anyone can spend your credits on. Make it an explicit choice.
  if (f.auth === undefined) {
    throw new FlagError(
      `--auth is required in non-interactive mode — a comma-separated list of ${AUTH_IDS.join(", ")}, or "none" for an open proxy`,
    );
  }
  const auth: AuthId[] =
    f.auth === "none"
      ? []
      : f.auth
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map((s) => oneOf<AuthId>(s, AUTH_IDS, "auth"));

  const answers: Answers = {
    target,
    storage,
    provider,
    auth,
    requestsPerMinute: wholeNumber(f.requestsPerMinute, 60, "--requests-per-minute"),
    tokensPerDay: wholeNumber(f.tokensPerDay, 200_000, "--tokens-per-day"),
  };
  // Blank/absent means "read it from the environment" — the config emits a
  // ${VAR} reference instead of a literal.
  if (f.firebaseProjectId) answers.firebaseProjectId = f.firebaseProjectId;
  if (f.firebaseProjectNumber) answers.firebaseProjectNumber = f.firebaseProjectNumber;
  if (f.appleTeamId) answers.appleTeamId = f.appleTeamId;
  if (f.appleBundleId) answers.appleBundleId = f.appleBundleId;
  return answers;
}
