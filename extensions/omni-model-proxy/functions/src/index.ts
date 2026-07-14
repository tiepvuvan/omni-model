import { CallableError, createOmniCallables } from "@omni-model/firebase";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { buildOmniConfig } from "./config.js";

// Initialize the Admin SDK exactly once per instance. Application Default
// Credentials are provided by the Cloud Functions runtime.
if (getApps().length === 0) {
  initializeApp();
}

const region = process.env.LOCATION?.trim() || "us-central1";
const requireAppCheck = process.env.REQUIRE_APP_CHECK !== "false";
const requireAuth = process.env.REQUIRE_AUTH !== "false";
// Opt-in App Check replay protection: only meaningful when clients send
// limited-use tokens (getLimitedUseToken / limitedUseAppCheckTokens: true).
const consumeAppCheckToken = process.env.CONSUME_APP_CHECK_TOKEN === "true";

if (!requireAuth) {
  // Without a Firebase user, a `key: user` rate-limit rule falls back to the
  // App Check app id — shared by every install — so limits become per-app, not
  // per-user. Surfaced loudly so an installer who disables auth understands it.
  console.warn(
    "[omni-model] REQUIRE_AUTH is false: per-user rate limits degrade to " +
      "per-app (all users share one bucket). Keep REQUIRE_AUTH=true for per-user limits.",
  );
}

/** Lazily-built, memoized callables — construction is async and validates config. */
let callablesPromise: ReturnType<typeof createOmniCallables> | undefined;

function getCallables(): ReturnType<typeof createOmniCallables> {
  if (callablesPromise === undefined) {
    callablesPromise = createOmniCallables({
      config: buildOmniConfig(process.env),
      firestore: getFirestore(),
      requireAuth,
      requireAppCheck,
    }).catch((error) => {
      // Reset so a transient startup failure can be retried on the next call
      // rather than being cached forever.
      callablesPromise = undefined;
      throw error;
    });
  }
  return callablesPromise;
}

/** Translate an adapter {@link CallableError} into the Functions {@link HttpsError} wire error. */
function toHttpsError(error: unknown): HttpsError {
  if (error instanceof CallableError) {
    return new HttpsError(error.code, error.message, error.details);
  }
  return new HttpsError("internal", "internal error");
}

// `enforceAppCheck` (callable protocol) and the adapter's `requireAppCheck`
// (identity check) are both driven by REQUIRE_APP_CHECK — defense in depth: the
// protocol rejects unattested calls at the edge, the adapter re-verifies intent.
const callableOptions = {
  enforceAppCheck: requireAppCheck,
  consumeAppCheckToken,
  cors: true,
  region,
  memory: "512MiB",
  timeoutSeconds: 300,
} as const;

/** OpenAI-compatible chat completions callable (`ext-<instanceId>-chat`). */
export const chat = onCall(callableOptions, async (request, response) => {
  try {
    const callables = await getCallables();
    return await callables.chat(request, response);
  } catch (error) {
    throw toHttpsError(error);
  }
});

/** OpenAI-compatible embeddings callable (`ext-<instanceId>-embeddings`). */
export const embeddings = onCall(callableOptions, async (request, response) => {
  try {
    const callables = await getCallables();
    return await callables.embeddings(request, response);
  } catch (error) {
    throw toHttpsError(error);
  }
});
