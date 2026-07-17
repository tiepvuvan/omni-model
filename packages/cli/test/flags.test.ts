import {
  createDefaultRegistry,
  createOmniApp,
  MemoryStorageAdapter,
  parseConfig,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { toYaml } from "../src/config.js";
import { answersFromFlags, FlagError, hasFlags } from "../src/flags.js";

/**
 * Non-interactive mode. The wizard's prompts can't be driven from CI, but this
 * path is a pure function — so it gets the coverage the prompts can't have.
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
  APPLE_DEVICECHECK_KEY: "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----",
};

describe("non-interactive flags", () => {
  it("skips the wizard only when --target is given", () => {
    expect(hasFlags({})).toBe(false);
    expect(hasFlags({ target: "cloudflare" })).toBe(true);
  });

  it("fills sensible defaults from just --target and --auth", () => {
    const a = answersFromFlags({ target: "cloudflare", auth: "none" });
    // Storage defaults to the best one for the target.
    expect(a.storage).toBe("durable-object");
    expect(a.provider).toEqual({ id: "openai", name: "openai", envVar: "OPENAI_API_KEY" });
    expect(a.auth).toEqual([]);
    expect(a.requestsPerMinute).toBe(60);
    expect(a.tokensPerDay).toBe(200_000);
  });

  it("defaults Cloud Run to Firestore, not to Cloudflare's storage", () => {
    expect(answersFromFlags({ target: "cloud-run", auth: "none" }).storage).toBe("firestore");
  });

  it("rejects a storage the target cannot run", () => {
    expect(() =>
      answersFromFlags({ target: "cloudflare", storage: "firestore", auth: "none" }),
    ).toThrowError(/isn't available on Cloudflare Workers.*durable-object, cloudflare-kv/s);
    expect(() =>
      answersFromFlags({ target: "fly", storage: "durable-object", auth: "none" }),
    ).toThrowError(/isn't available on Fly\.io/);
  });

  it("requires --auth explicitly, so an open proxy is never a silent default", () => {
    expect(() => answersFromFlags({ target: "docker" })).toThrowError(FlagError);
    expect(() => answersFromFlags({ target: "docker" })).toThrowError(/--auth is required/);
    // "none" is accepted, but you have to say it.
    expect(answersFromFlags({ target: "docker", auth: "none" }).auth).toEqual([]);
  });

  it("parses a comma-separated verifier list", () => {
    const a = answersFromFlags({
      target: "docker",
      auth: "firebase-auth, apple-device-check",
    });
    expect(a.auth).toEqual(["firebase-auth", "apple-device-check"]);
  });

  it("names the valid values when a flag is wrong", () => {
    expect(() => answersFromFlags({ target: "heroku", auth: "none" })).toThrowError(
      /unknown target "heroku" — valid: cloudflare, cloud-run, fly, render, docker/,
    );
    expect(() => answersFromFlags({ target: "docker", auth: "magic" })).toThrowError(
      /unknown auth "magic" — valid: firebase-auth/,
    );
    expect(() =>
      answersFromFlags({ target: "docker", provider: "llama", auth: "none" }),
    ).toThrowError(/unknown provider "llama"/);
  });

  it("requires --base-url for openai-compatible and derives its key env", () => {
    expect(() =>
      answersFromFlags({ target: "docker", provider: "openai-compatible", auth: "none" }),
    ).toThrowError(/--base-url is required/);
    const a = answersFromFlags({
      target: "docker",
      provider: "openai-compatible",
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: "none",
    });
    expect(a.provider.envVar).toBe("OPENROUTER_API_KEY");
    expect(a.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("validates numbers and URLs", () => {
    expect(() =>
      answersFromFlags({ target: "docker", auth: "none", requestsPerMinute: "lots" }),
    ).toThrowError(/--requests-per-minute must be a whole number/);
    expect(() =>
      answersFromFlags({ target: "docker", auth: "none", baseUrl: "ftp://x" }),
    ).toThrowError(/--base-url must be an http\(s\) URL/);
  });

  it("omits identity values so the config emits ${VAR} references instead", () => {
    const withId = answersFromFlags({
      target: "docker",
      auth: "firebase-auth",
      firebaseProjectId: "my-project",
    });
    expect(toYaml(withId)).toContain("projectId: my-project");
    const withoutId = answersFromFlags({ target: "docker", auth: "firebase-auth" });
    expect(toYaml(withoutId)).toContain("${FIREBASE_PROJECT_ID}");
  });

  it("produces a config that parses AND builds a real app", async () => {
    const a = answersFromFlags({
      target: "cloud-run",
      auth: "firebase-auth,firebase-app-check,apple-app-attest,apple-device-check",
      requestsPerMinute: "30",
      tokensPerDay: "1000",
    });
    const config = parseConfig(toYaml(a), TEST_ENV);
    await expect(
      createOmniApp({
        config,
        registry: createDefaultRegistry(),
        env: TEST_ENV,
        storage: new MemoryStorageAdapter(() => 0),
      }),
    ).resolves.toBeDefined();
  });
});
