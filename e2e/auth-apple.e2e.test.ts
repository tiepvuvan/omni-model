import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningTarget, startNodeTarget } from "./support/proxy-targets.js";

/**
 * End-to-end: the two **Apple** verifiers' server side, against a REAL Apple
 * DeviceCheck key + Team. The device-signed tokens themselves need a physical
 * device (the example app's on-device screen), but everything up to that — the
 * config, the ES256 JWT the proxy signs for Apple's DeviceCheck API, and the
 * App Attest challenge/register routes — is verifiable headlessly here.
 *
 * The strongest check: send a *bogus* DeviceCheck token and read Apple's reply.
 * Apple returns HTTP 400 ("device token payload") only when it has already
 * ACCEPTED our signing JWT — i.e. the Team ID, Key ID, and .p8 are all correct.
 * A wrong key would be HTTP 401.
 *
 * The config also carries the Firebase verifiers under `mode: "any"`, so this
 * doubles as proof that a mixed verifier set constructs and dispatches.
 *
 * Opt-in — needs the Apple + Firebase env from the device-auth config:
 *   OPENROUTER_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_PROJECT_NUMBER,
 *   APPLE_TEAM_ID, APPLE_BUNDLE_ID, APPLE_DEVICECHECK_KEY_ID, APPLE_DEVICECHECK_KEY
 */
const OPENROUTER = process.env.OPENROUTER_API_KEY;
const TEAM_ID = process.env.APPLE_TEAM_ID;
const KEY_ID = process.env.APPLE_DEVICECHECK_KEY_ID;
const P8 = process.env.APPLE_DEVICECHECK_KEY;
const BUNDLE_ID = process.env.APPLE_BUNDLE_ID;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const PROJECT_NUMBER = process.env.FIREBASE_PROJECT_NUMBER;

const READY = Boolean(
  OPENROUTER && TEAM_ID && KEY_ID && P8 && BUNDLE_ID && PROJECT_ID && PROJECT_NUMBER,
);

const configJson = readFileSync(
  fileURLToPath(new URL("./omni.device-auth.json", import.meta.url)),
  "utf8",
);

describe.skipIf(!READY)("E2E Apple auth (container)", () => {
  let proxy: RunningTarget;

  beforeAll(async () => {
    proxy = await startNodeTarget(configJson, process.env);
  }, 100_000);

  afterAll(async () => {
    await proxy?.stop();
  });

  it("mounts a live App Attest challenge route", async () => {
    const res = await fetch(`${proxy.base}/auth/app-attest/challenge`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge?: string };
    expect(typeof json.challenge).toBe("string");
    expect((json.challenge ?? "").length).toBeGreaterThan(0);
  });

  it("runs the DeviceCheck verifier and rejects a bogus token (401)", {
    timeout: 30_000,
  }, async () => {
    const res = await fetch(`${proxy.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-apple-device-token": bogusToken() },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    });
    // The verifier is wired, called Apple, and rejected the token.
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("Apple rejected the device token");

    // Apple returns HTTP 400 ("device token payload") — proving it ACCEPTED
    // the signing JWT, so the Team/Key/.p8 config is valid.
    expect(json.error?.message).toContain("HTTP 400");
  });
});

function bogusToken(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}
