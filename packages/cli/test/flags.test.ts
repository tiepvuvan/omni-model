import {
  createDefaultRegistry,
  createOmniApp,
  MemoryStorageAdapter,
  parseEnvironmentConfig,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { configEnvironment } from "../src/config.js";
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
    const a = answersFromFlags({ target: "cloudflare", auth: "firebase-auth" });
    expect(a.auth).toEqual(["firebase-auth"]);
    // Storage defaults to the best one for the target.
    expect(a.storage).toBe("durable-object");
    expect(a.provider).toEqual({ id: "openai", name: "openai", envVar: "OPENAI_API_KEY" });
    expect(a.requestsPerMinute).toBe(60);
    expect(a.tokensPerDay).toBe(200_000);
  });

  it("defaults Cloud Run to Firestore, not to Cloudflare's storage", () => {
    expect(answersFromFlags({ target: "cloud-run", auth: "firebase-auth" }).storage).toBe(
      "firestore",
    );
  });

  it("rejects a storage the target cannot run", () => {
    expect(() =>
      answersFromFlags({ target: "cloudflare", storage: "firestore", auth: "firebase-auth" }),
    ).toThrowError(/isn't available on Cloudflare Workers.*durable-object, cloudflare-kv/s);
    expect(() =>
      answersFromFlags({ target: "fly", storage: "durable-object", auth: "firebase-auth" }),
    ).toThrowError(/isn't available on Fly\.io/);
  });

  it("requires at least one verifier — there is no unauthenticated option", () => {
    expect(() => answersFromFlags({ target: "docker" })).toThrowError(FlagError);
    expect(() => answersFromFlags({ target: "docker" })).toThrowError(/--auth is required/);
    // An empty list is refused too — running without auth is not supported.
    expect(() => answersFromFlags({ target: "docker", auth: "" })).toThrowError(
      /needs at least one verifier/,
    );
    expect(() => answersFromFlags({ target: "docker", auth: "none" })).toThrowError(
      /unknown auth "none"/,
    );
  });

  it("parses a comma-separated verifier list", () => {
    const a = answersFromFlags({
      target: "docker",
      auth: "firebase-auth, apple-device-check",
    });
    expect(a.auth).toEqual(["firebase-auth", "apple-device-check"]);
  });

  it("names the valid values when a flag is wrong", () => {
    expect(() => answersFromFlags({ target: "heroku", auth: "firebase-auth" })).toThrowError(
      /unknown target "heroku" — valid: cloudflare, cloud-run, fly, render, docker/,
    );
    expect(() => answersFromFlags({ target: "docker", auth: "magic" })).toThrowError(
      /unknown auth "magic" — valid: firebase-auth/,
    );
    expect(() =>
      answersFromFlags({ target: "docker", provider: "llama", auth: "firebase-auth" }),
    ).toThrowError(/unknown provider "llama"/);
  });

  it("requires --base-url for openai-compatible and derives its key env", () => {
    expect(() =>
      answersFromFlags({ target: "docker", provider: "openai-compatible", auth: "firebase-auth" }),
    ).toThrowError(/--base-url is required/);
    const a = answersFromFlags({
      target: "docker",
      provider: "openai-compatible",
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: "firebase-auth",
    });
    expect(a.provider.envVar).toBe("OPENROUTER_API_KEY");
    expect(a.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("validates numbers and URLs", () => {
    expect(() =>
      answersFromFlags({ target: "docker", auth: "firebase-auth", requestsPerMinute: "lots" }),
    ).toThrowError(/--requests-per-minute must be a whole number/);
    expect(() =>
      answersFromFlags({ target: "docker", auth: "firebase-auth", baseUrl: "ftp://x" }),
    ).toThrowError(/--base-url must be an http\(s\) URL/);
  });

  it("omits identity values so the config emits environment references instead", () => {
    const withId = answersFromFlags({
      target: "docker",
      auth: "firebase-auth",
      firebaseProjectId: "my-project",
    });
    expect(JSON.stringify(configEnvironment(withId))).toContain("my-project");
    const withoutId = answersFromFlags({ target: "docker", auth: "firebase-auth" });
    expect(JSON.stringify(configEnvironment(withoutId))).toContain("$" + "{FIREBASE_PROJECT_ID}");
  });

  it("produces a config that parses AND builds a real app", async () => {
    const a = answersFromFlags({
      target: "cloud-run",
      auth: "firebase-auth,firebase-app-check,apple-app-attest,apple-device-check",
      requestsPerMinute: "30",
      tokensPerDay: "1000",
    });
    const config = parseEnvironmentConfig({ ...TEST_ENV, ...configEnvironment(a) });
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
