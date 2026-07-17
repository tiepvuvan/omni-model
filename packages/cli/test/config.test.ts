import { parseConfig } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import {
  type Answers,
  type AuthId,
  envVarsFor,
  type ProviderChoice,
  toYaml,
} from "../src/config.js";
import { STORAGE, storagesFor, TARGETS, type TargetId } from "../src/targets.js";

/**
 * The wizard's whole job is to emit a config the proxy will actually accept, so
 * the test that matters is: every combination it can produce parses against the
 * REAL schema in @omni-model/core (aliased to source by vitest.config.ts).
 *
 * A hand-written YAML template drifts from the schema silently; this catches it
 * offline, in milliseconds, with no deploy.
 */

/** Env for `${VAR}` interpolation — the vars the CLI tells users to set. */
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
  APPLE_DEVICECHECK_KEY: "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----",
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

const AUTH_SETS: AuthId[][] = [
  [],
  ["firebase-auth"],
  ["firebase-app-check"],
  ["apple-app-attest"],
  ["apple-device-check"],
  ["firebase-auth", "firebase-app-check", "apple-app-attest", "apple-device-check"],
];

/** Every combination the wizard can reach. */
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
            requestsPerMinute: 60,
            tokensPerDay: 200_000,
          });
        }
      }
    }
  }
  return out;
}

describe("generated config", () => {
  const answers = everyAnswer();

  it("covers every target/storage combination the wizard offers", () => {
    expect(answers.length).toBeGreaterThan(50);
    // Sanity: the wizard never offers a storage a target can't run.
    for (const target of Object.keys(TARGETS) as TargetId[]) {
      for (const s of storagesFor(target)) expect(STORAGE[s.id]).toBeDefined();
    }
    expect(storagesFor("cloudflare").map((s) => s.id)).toEqual(["durable-object", "cloudflare-kv"]);
    expect(storagesFor("cloud-run")[0]?.id).toBe("firestore");
  });

  it("every combination parses against the real schema", () => {
    for (const a of answers) {
      const yaml = toYaml(a);
      const label = `${a.target}/${a.storage}/${a.provider.name}/[${a.auth.join(",")}]`;
      expect(() => parseConfig(yaml, TEST_ENV), `${label}\n${yaml}`).not.toThrow();
    }
  });

  it("never writes a secret value — provider keys stay env references", () => {
    for (const a of answers) {
      const parsed = parseConfig(toYaml(a), TEST_ENV) as unknown as {
        providers: Record<string, { apiKey?: string }>;
      };
      // Interpolation resolved it to the test env value, proving it was a
      // reference in the file rather than a literal.
      expect(parsed.providers[a.provider.name]?.apiKey).toBe(TEST_ENV[a.provider.envVar]);
      expect(toYaml(a)).toContain(`\${${a.provider.envVar}}`);
    }
  });

  it("tells the user about every env placeholder the config references", () => {
    for (const a of answers) {
      const yaml = toYaml(a);
      const referenced = new Set(
        [...yaml.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string),
      );
      const advertised = new Set(envVarsFor(a));
      for (const v of referenced) {
        expect(
          advertised.has(v),
          `${a.target}/${a.storage}: config uses \${${v}} but envVarsFor() omits it`,
        ).toBe(true);
      }
    }
  });

  it("keys limits on the identity when authenticated, and on ip when open", () => {
    const open = toYaml({ ...(answers[0] as Answers), auth: [] });
    expect(open).toContain("key: ip");
    const secured = toYaml({ ...(answers[0] as Answers), auth: ["firebase-auth"] });
    expect(secured).toContain("key: user");
  });

  it("omits a limit rule when the user asks for none", () => {
    const cfg = parseConfig(
      toYaml({ ...(answers[0] as Answers), requestsPerMinute: 0, tokensPerDay: 0 }),
      TEST_ENV,
    ) as unknown as { rateLimits: unknown[] };
    expect(cfg.rateLimits).toEqual([]);
  });
});
