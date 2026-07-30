import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFirebaseTestSession,
  exchangeAppCheckDebugToken,
  type FirebaseTestSession,
} from "../support/firebase-tokens.js";
import { readOptionalLiveInput } from "../support/live-inputs.js";
import {
  type LiveSecurityTarget,
  type LiveVerificationTarget,
  startLiveSecurityTarget,
  startLiveVerificationTarget,
} from "../support/live-verification.js";

const env = process.env;
const API_KEY = nonEmpty(env.FIREBASE_API_KEY);
const PROJECT_ID = nonEmpty(env.FIREBASE_PROJECT_ID);
const PROJECT_NUMBER = nonEmpty(env.FIREBASE_PROJECT_NUMBER);
const APP_ID = nonEmpty(env.FIREBASE_APP_ID);
const DEBUG_TOKEN =
  nonEmpty(env.FIREBASE_APPCHECK_DEBUG_TOKEN) ??
  readOptionalLiveInput(env.FIREBASE_APPCHECK_DEBUG_TOKEN_FILE);
const AUTH_SERVICE_ACCOUNT_KEY =
  nonEmpty(env.FIREBASE_AUTH_SERVICE_ACCOUNT_KEY) ??
  readOptionalLiveInput(env.GOOGLE_APPLICATION_CREDENTIALS);
const CONSUME = env.FIREBASE_APPCHECK_TEST_CONSUME === "true";

const AUTH_READY = API_KEY !== undefined && PROJECT_ID !== undefined;
const APP_CHECK_READY =
  API_KEY !== undefined &&
  PROJECT_NUMBER !== undefined &&
  APP_ID !== undefined &&
  DEBUG_TOKEN !== undefined;
const COMBINED_READY = AUTH_READY && APP_CHECK_READY;

enforceRequiredChecks();

describe.skipIf(!AUTH_READY)("E2E live provider: Firebase Authentication", () => {
  let target: LiveSecurityTarget;
  let session: FirebaseTestSession;

  beforeAll(async () => {
    session = await createFirebaseTestSession(API_KEY as string, {
      ...(AUTH_SERVICE_ACCOUNT_KEY === undefined
        ? {}
        : { serviceAccountKey: AUTH_SERVICE_ACCOUNT_KEY }),
    });
    target = await startLiveSecurityTarget({
      userAuth: { type: "firebase-auth", projectId: PROJECT_ID },
    });
  }, 30_000);

  afterAll(async () => {
    await target?.stop();
    await session?.delete();
  });

  it("rejects a request without a Firebase ID token", async () => {
    const response = await target.request();
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(0);
    await response.body?.cancel();
  });

  it("rejects a tampered Firebase ID token before routing", async () => {
    const response = await target.request({
      "x-firebase-id-token": `${session.idToken}tampered`,
    });
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(0);
    await response.body?.cancel();
  });

  it("accepts a genuine Firebase ID token and reaches routing", async () => {
    const response = await target.request({ "x-firebase-id-token": session.idToken });
    expect(response.status).toBe(200);
    expect(target.upstreamCalls()).toBe(1);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "verified" } }],
    });
  });
});

describe.skipIf(!APP_CHECK_READY)("E2E live provider: Firebase App Check", () => {
  let target: LiveVerificationTarget;
  let token: string;

  beforeAll(async () => {
    token = await exchangeAppCheckDebugToken({
      apiKey: API_KEY as string,
      projectNumber: PROJECT_NUMBER as string,
      appId: APP_ID as string,
      debugToken: DEBUG_TOKEN as string,
      limitedUse: CONSUME,
    });
    target = await startLiveVerificationTarget(
      {
        type: "firebase-app-check",
        projectNumber: PROJECT_NUMBER,
        appIds: [APP_ID],
        consume: CONSUME,
      },
      env,
    );
  }, 30_000);

  afterAll(async () => {
    await target?.stop();
  });

  it("rejects a bogus App Check token before routing", async () => {
    const response = await target.request("x-firebase-appcheck", "not-a-real-app-check-token");
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(0);
    await response.body?.cancel();
  });

  it("accepts a genuine App Check token and reaches routing", async () => {
    const response = await target.request("x-firebase-appcheck", token);
    expect(response.status).toBe(200);
    expect(target.upstreamCalls()).toBe(1);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "verified" } }],
    });
  });

  it.skipIf(!CONSUME)("rejects a replayed limited-use token", async () => {
    const response = await target.request("x-firebase-appcheck", token);
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(1);
    await response.body?.cancel();
  });
});

describe.skipIf(!COMBINED_READY)("E2E live provider: Firebase Auth + App Check", () => {
  let target: LiveSecurityTarget;
  let session: FirebaseTestSession;
  let appCheckToken: string;

  beforeAll(async () => {
    session = await createFirebaseTestSession(API_KEY as string, {
      ...(AUTH_SERVICE_ACCOUNT_KEY === undefined
        ? {}
        : { serviceAccountKey: AUTH_SERVICE_ACCOUNT_KEY }),
    });
    appCheckToken = await exchangeAppCheckDebugToken({
      apiKey: API_KEY as string,
      projectNumber: PROJECT_NUMBER as string,
      appId: APP_ID as string,
      debugToken: DEBUG_TOKEN as string,
    });
    target = await startLiveSecurityTarget({
      userAuth: { type: "firebase-auth", projectId: PROJECT_ID },
      appAuth: {
        mode: "all",
        providers: [
          {
            type: "firebase-app-check",
            projectNumber: PROJECT_NUMBER,
            appIds: [APP_ID],
          },
        ],
      },
    });
  }, 30_000);

  afterAll(async () => {
    await target?.stop();
    await session?.delete();
  });

  it("requires the App Check layer after authenticating the user", async () => {
    const response = await target.request({ "x-firebase-id-token": session.idToken });
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(0);
    await response.body?.cancel();
  });

  it("requires the user layer after attesting the app", async () => {
    const response = await target.request({ "x-firebase-appcheck": appCheckToken });
    expect(response.status).toBe(401);
    expect(target.upstreamCalls()).toBe(0);
    await response.body?.cancel();
  });

  it("accepts both genuine credentials and reaches routing", async () => {
    const response = await target.request({
      "x-firebase-id-token": session.idToken,
      "x-firebase-appcheck": appCheckToken,
    });
    expect(response.status).toBe(200);
    expect(target.upstreamCalls()).toBe(1);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "verified" } }],
    });
  });
});

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function enforceRequiredChecks(): void {
  const requested = (env.OMNI_E2E_REQUIRE_FIREBASE ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const supported = new Set(["auth", "app-check", "combined", "replay-protection"]);
  for (const check of requested) {
    if (!supported.has(check)) {
      throw new Error(`OMNI_E2E_REQUIRE_FIREBASE contains unsupported check "${check}"`);
    }
  }
  if (requested.length === 0) return;

  const missing = new Set<string>();
  const requireAuth = requested.includes("auth") || requested.includes("combined");
  const requireAppCheck =
    requested.includes("app-check") ||
    requested.includes("combined") ||
    requested.includes("replay-protection");
  if (requireAuth) {
    if (API_KEY === undefined) missing.add("FIREBASE_API_KEY");
    if (PROJECT_ID === undefined) missing.add("FIREBASE_PROJECT_ID");
  }
  if (requireAppCheck) {
    if (API_KEY === undefined) missing.add("FIREBASE_API_KEY");
    if (PROJECT_NUMBER === undefined) missing.add("FIREBASE_PROJECT_NUMBER");
    if (APP_ID === undefined) missing.add("FIREBASE_APP_ID");
    if (DEBUG_TOKEN === undefined) {
      missing.add("FIREBASE_APPCHECK_DEBUG_TOKEN or FIREBASE_APPCHECK_DEBUG_TOKEN_FILE");
    }
  }
  if (requested.includes("replay-protection") && !CONSUME) {
    missing.add("FIREBASE_APPCHECK_TEST_CONSUME=true");
  }
  if (missing.size > 0) {
    throw new Error(`required live Firebase E2E input is missing: ${[...missing].join(", ")}`);
  }
}
