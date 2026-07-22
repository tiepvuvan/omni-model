import {
  createDefaultRegistry,
  createOmniApp,
  MemoryStorageAdapter,
  parseEnvironmentConfig,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";
import {
  type Answers,
  type AuthId,
  configEnvironment,
  type ProviderChoice,
} from "../src/config.js";
import { storagesFor, TARGETS, type TargetId } from "../src/targets.js";

/**
 * Stronger than the schema test: every config the wizard can emit must actually
 * BUILD an app.
 *
 * `parseEnvironmentConfig` only validates the two-step schema — it pins the discriminating
 * `type` and stops. The per-component options (a provider's apiKey, a
 * verifier's teamId, the DeviceCheck PEM, CEL routing, duplicate rule names)
 * are validated by each factory at `createOmniApp` time, which is where a bad
 * generated config would actually blow up — at the user's first request, on
 * their deployed proxy.
 *
 * Constructing and discarding the app is the only thing that catches those, and
 * it works for every target: passing `storage` skips storage construction
 * (app.ts:81), so Cloudflare's Durable Object/KV configs validate here too
 * without any bindings.
 */

const TEST_ENV: Record<string, string> = {
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-test",
  GEMINI_API_KEY: "sk-test",
  OPENROUTER_API_KEY: "sk-or-test",
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgres://localhost/omni",
  FIREBASE_PROJECT_ID: "demo-project",
  FIREBASE_PROJECT_NUMBER: "1234567890",
  APPLE_TEAM_ID: "ABCDE12345",
  APPLE_BUNDLE_ID: "com.example.app",
  APPLE_DEVICECHECK_KEY_ID: "KEY1234567",
  // The DeviceCheck factory rejects anything without this header, so a
  // generated config that mis-wires it would fail here.
  APPLE_DEVICECHECK_KEY:
    "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQ==\n-----END PRIVATE KEY-----",
};

const PROVIDERS: ProviderChoice[] = [
  { id: "openai", name: "openai", envVar: "OPENAI_API_KEY" },
  { id: "anthropic", name: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { id: "google", name: "google", envVar: "GEMINI_API_KEY" },
  {
    id: "openai-compatible",
    name: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
];

// No empty set: a verifier is mandatory, so the wizard can't produce one.
const AUTH_SETS: AuthId[][] = [
  ["firebase-auth"],
  ["firebase-app-check"],
  ["apple-app-attest"],
  ["apple-device-check"],
  ["firebase-auth", "firebase-app-check", "apple-app-attest", "apple-device-check"],
];

function everyAnswer(): Answers[] {
  const out: Answers[] = [];
  for (const target of Object.keys(TARGETS) as TargetId[]) {
    for (const storage of storagesFor(target)) {
      for (const provider of PROVIDERS) {
        for (const auth of AUTH_SETS) {
          out.push({
            target,
            storage: storage.id,
            provider,
            auth,
            requestsPerHour: 30,
            tokensPerDay: 30_000,
          });
        }
      }
    }
  }
  return out;
}

describe("generated config builds a real app", () => {
  it("createOmniApp accepts every combination the wizard can emit", async () => {
    for (const a of everyAnswer()) {
      const label = `${a.target}/${a.storage}/${a.provider.name}/[${a.auth.join(",")}]`;
      const config = parseEnvironmentConfig({ ...TEST_ENV, ...configEnvironment(a) });
      await expect(
        createOmniApp({
          config,
          registry: createDefaultRegistry(),
          env: TEST_ENV,
          // Injecting storage skips the storage factory, so Workers-only
          // backends validate without bindings.
          storage: new MemoryStorageAdapter(() => 0),
        }),
        label,
      ).resolves.toBeDefined();
    }
  });

  it("serves /healthz and refuses an unauthenticated /v1 when a verifier is configured", async () => {
    const answers: Answers = {
      target: "docker",
      storage: "memory",
      provider: PROVIDERS[0] as ProviderChoice,
      auth: ["firebase-auth"],
      requestsPerHour: 30,
      tokensPerDay: 0,
    };
    const app = await createOmniApp({
      config: parseEnvironmentConfig({ ...TEST_ENV, ...configEnvironment(answers) }),
      registry: createDefaultRegistry(),
      env: TEST_ENV,
      storage: new MemoryStorageAdapter(() => 0),
    });
    expect((await app.fetch(new Request("http://x/healthz"))).status).toBe(200);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    // The wizard promised auth; the generated config must actually enforce it.
    expect(res.status).toBe(401);
  });
});
