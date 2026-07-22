import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchangeAppCheckDebugToken, mintFirebaseIdToken } from "./support/firebase-tokens.js";
import { type RunningTarget, startNodeTarget, startWorkerTarget } from "./support/proxy-targets.js";

/**
 * End-to-end: Firebase **Auth** and **App Check** verification against a REAL
 * Firebase project, on BOTH deploy targets — the Node container AND the
 * Cloudflare worker in workerd. The proxy runs with `security.mode: any` and
 * both Firebase verifiers enabled; each credential is minted from Google's real
 * REST APIs and presented to a running proxy, which must accept the genuine
 * token (and complete a real chat) and reject a forged one.
 *
 * This is the device-free half of the auth story. App Attest / DeviceCheck need
 * a physical device and are exercised by the on-device verification screen in
 * the example iOS app (see docs/security/verify-on-device).
 *
 * Opt-in — needs, from the app's GoogleService-Info.plist + an OpenRouter key:
 *   OPENROUTER_API_KEY, FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_PROJECT_NUMBER
 * App Check additionally needs a registered debug token:
 *   FIREBASE_APP_ID, FIREBASE_APPCHECK_DEBUG_TOKEN
 *
 *   OPENROUTER_API_KEY=... FIREBASE_API_KEY=... FIREBASE_PROJECT_ID=... \
 *   FIREBASE_PROJECT_NUMBER=... pnpm test:e2e
 */
const OPENROUTER = process.env.OPENROUTER_API_KEY;
const API_KEY = process.env.FIREBASE_API_KEY;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const PROJECT_NUMBER = process.env.FIREBASE_PROJECT_NUMBER;
const APP_ID = process.env.FIREBASE_APP_ID;
const DEBUG_TOKEN = process.env.FIREBASE_APPCHECK_DEBUG_TOKEN;
const MODEL = process.env.OMNI_E2E_MODEL ?? "openai/gpt-4o-mini";

const READY = Boolean(OPENROUTER && API_KEY && PROJECT_ID && PROJECT_NUMBER);
const APP_CHECK_READY = Boolean(READY && APP_ID && DEBUG_TOKEN);

const nodeConfigJson = readFileSync(
  fileURLToPath(new URL("./omni.auth.e2e.json", import.meta.url)),
  "utf8",
);
// Same config, but Durable Object storage for the worker.
const workerConfigJson = JSON.stringify({
  ...(JSON.parse(nodeConfigJson) as Record<string, unknown>),
  storage: { type: "durable-object", binding: "OMNI_DO" },
});

interface Target {
  name: string;
  start: () => Promise<RunningTarget>;
}

const TARGETS: Target[] = [
  {
    name: "Node container",
    start: () => startNodeTarget(nodeConfigJson, process.env),
  },
  {
    name: "Cloudflare Worker (workerd)",
    start: () =>
      startWorkerTarget({
        omniConfigJson: workerConfigJson,
        vars: {
          OPENROUTER_API_KEY: OPENROUTER ?? "",
          FIREBASE_PROJECT_ID: PROJECT_ID ?? "",
          FIREBASE_PROJECT_NUMBER: PROJECT_NUMBER ?? "",
        },
        port: 8801,
      }),
  },
];

describe.skipIf(!READY).each(TARGETS)("E2E auth: $name → OpenRouter", (target) => {
  let proxy: RunningTarget;

  beforeAll(async () => {
    proxy = await target.start();
  }, 100_000);

  afterAll(async () => {
    await proxy?.stop();
  });

  const chat = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${proxy.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: 'Reply with exactly "pong".' }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

  it("rejects a request with no credential (401)", async () => {
    const res = await chat({});
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("accepts a real Firebase ID token and completes a chat (200)", {
    timeout: 30_000,
  }, async () => {
    const idToken = await mintFirebaseIdToken(API_KEY as string);
    const res = await chat({ authorization: `Bearer ${idToken}` });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    expect(json.choices?.[0]?.message?.content?.toLowerCase()).toContain("pong");
  });

  it("rejects a tampered Firebase ID token (401)", { timeout: 30_000 }, async () => {
    const idToken = await mintFirebaseIdToken(API_KEY as string);
    // Corrupt the signature segment.
    const res = await chat({ authorization: `Bearer ${idToken}tampered` });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it.skipIf(!APP_CHECK_READY)(
    "accepts a real App Check token (200)",
    { timeout: 30_000 },
    async () => {
      const token = await exchangeAppCheckDebugToken({
        apiKey: API_KEY as string,
        projectNumber: PROJECT_NUMBER as string,
        appId: APP_ID as string,
        debugToken: DEBUG_TOKEN as string,
      });
      const res = await chat({ "x-firebase-appcheck": token });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    },
  );

  it.skipIf(!APP_CHECK_READY)("rejects a bogus App Check token (401)", async () => {
    const res = await chat({ "x-firebase-appcheck": "not-a-real-app-check-token" });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});
