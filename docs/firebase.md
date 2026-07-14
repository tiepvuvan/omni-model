# Firebase (serverless, no backend)

Run omni-model as **Firebase Callable Functions** so a mobile or web app can call an LLM proxy
with no server to operate. Rate limits and token budgets live in **Firestore**; authentication is
whatever your app already uses — **Firebase Auth** and **App Check** — because the Firebase client
SDKs attach those tokens to every callable request automatically.

This is packaged as a one-click **Firebase Extension** (`extensions/omni-model-proxy`) and, for
custom setups, as two libraries you can wire into your own Cloud Functions:

- [`@omni-model/storage-firestore`](../packages/storage-firestore) — the Firestore `StorageAdapter`.
- [`@omni-model/firebase`](../packages/firebase) — maps a callable's Auth + App Check context to an
  omni-model identity and runs streaming chat + embeddings through the core pipeline.

## Why callables

With a callable, the client SDK verifies and forwards the caller's identity for you:

- **Firebase Auth ID token** → `request.auth.uid` (+ decoded claims). omni-model keys per-user rate
  limits on the uid.
- **App Check token** → `request.app.appId`, proving the call came from a genuine build of your app.
- The provider API keys stay in Cloud Secret Manager, never in the app binary.

omni-model's own HTTP auth verifiers are **not** used here — Firebase does the auth, and the
adapter maps its result straight to an identity. (`security.providers` stays empty.)

## Install the Extension

Prerequisites: the **Blaze** plan (Cloud Functions + Secret Manager), at least one provider API
key, and — recommended — [App Check](https://firebase.google.com/docs/app-check) and
[Auth](https://firebase.google.com/docs/auth) configured in your app.

```sh
firebase ext:install ./extensions/omni-model-proxy --project=YOUR_PROJECT
# or, once published to the Extensions Hub:
# firebase ext:install <publisher>/omni-model-proxy --project=YOUR_PROJECT
```

You'll be prompted for the install parameters:

| Parameter | Default | Notes |
| --- | --- | --- |
| `LOCATION` | `us-central1` | Function region (immutable). |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | — | Secret; set at least one. |
| `DEFAULT_PROVIDER` | `openai` | Falls back to the first configured provider. |
| `REQUESTS_PER_MINUTE` | `60` | Per-user request limit. |
| `DAILY_TOKEN_BUDGET` | `200000` | Per-user daily token budget. |
| `REQUIRE_APP_CHECK` | `true` | Reject calls without a valid App Check token. |
| `REQUIRE_AUTH` | `true` | Reject calls without a signed-in user. |
| `CONSUME_APP_CHECK_TOKEN` | `false` | Single-use App Check tokens (needs limited-use tokens). |
| `FIRESTORE_COLLECTION` | `omni_ratelimits` | Firestore collection for counters. |
| `ADVANCED_CONFIG_YAML` | — | A full [omni.yaml](configuration.md) that overrides everything above (CEL routing, extra providers). |

The extension deploys two functions, `ext-<instanceId>-chat` and `ext-<instanceId>-embeddings`
(the instance id defaults to `omni-model-proxy`).

## Call it from your app

The request/response payloads are the OpenAI shapes. Chat streams token-by-token via the callable
streaming API.

```js
import { getFunctions, httpsCallable } from "firebase/functions";
// Firebase Auth + App Check are initialized elsewhere; their tokens are attached automatically.

const functions = getFunctions();
const chat = httpsCallable(functions, "ext-omni-model-proxy-chat");

// Streaming:
const { stream, data } = await chat.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Write a haiku about the sea." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}
const final = await data; // the aggregated ChatCompletion

// Non-streaming:
const res = await chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] });
console.log(res.data.choices[0].message.content);
```

Swift (`FirebaseFunctions`) and Kotlin/Java clients call the same function names via their callable
APIs; App Check and Auth tokens are attached by those SDKs too.

Errors arrive as `FunctionsError` with a canonical code — `unauthenticated` (missing Auth),
`failed-precondition` (missing App Check), `resource-exhausted` (rate limit / token budget),
`invalid-argument` (bad payload).

## Embed it yourself (custom functions)

If you don't want the packaged extension, wire the adapter into your own 2nd-gen functions:

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createOmniCallables, CallableError } from "@omni-model/firebase";
import { parseConfig } from "@omni-model/core";

if (!getApps().length) initializeApp();

const callablesPromise = createOmniCallables({
  config: parseConfig(MY_YAML, process.env), // storage: { type: firestore }
  firestore: getFirestore(),
  requireAuth: true,
  requireAppCheck: true,
});

export const chat = onCall({ enforceAppCheck: true, cors: true }, async (request, response) => {
  try {
    return await (await callablesPromise).chat(request, response);
  } catch (e) {
    if (e instanceof CallableError) throw new HttpsError(e.code, e.message, e.details);
    throw new HttpsError("internal", "internal error");
  }
});
```

The Firestore storage backend is a normal omni-model storage type:

```yaml
storage:
  type: firestore
  collection: omni_ratelimits   # optional
```

You register it with the injected Firestore client (it can't come from YAML because it carries
credentials): `createOmniCallables` does this for you; in a bare setup call
`createFirestoreStorageFactory(getFirestore())` and register it on the core registry.

## How Firestore rate limiting behaves

- Counters are per `rl:<kind>:<rule>:<user>:<window>` document. `increment` runs in a
  `runTransaction` (atomic, retry-safe) and returns the post-increment value.
- **Correctness is computed on read** by comparing a stored `expiresAt` to the current time.
  Firestore's native [TTL policies](https://firebase.google.com/docs/firestore/ttl) are
  best-effort cleanup (~24h) — optional, and never relied on for the window boundary.
- A single Firestore document sustains only ~1 write/sec, so **per-user** keys are ideal. Avoid a
  single global/`ip` key on Firestore for high-traffic apps (it would contend); use Redis for that
  shape.
- Rate limiting is **fail-open**: a Firestore outage lets requests through rather than taking your
  app down.

## Caveats before publishing

- **Verify in the emulator first.** The 2nd-gen callable-in-Extension format is newer than the
  1st-gen examples in Firebase's docs. Run
  `firebase ext:dev:emulators:start --test-params=test-params.env` and exercise both `chat`
  (streaming via `.stream()` and non-streaming) and `embeddings` before `firebase ext:dev:upload`.
- **`REQUIRE_AUTH=false` makes per-user limits per-app.** Without a signed-in user, a `key: user`
  rule falls back to the App Check app id, which every install shares — so all users share one
  bucket. Keep `REQUIRE_AUTH=true` for genuine per-user limits.
- **App Check replay:** baseline App Check tokens are short-lived but replayable. Set
  `CONSUME_APP_CHECK_TOKEN=true` **only** if your app requests limited-use tokens
  (`getLimitedUseToken()`), or valid calls will be rejected.
