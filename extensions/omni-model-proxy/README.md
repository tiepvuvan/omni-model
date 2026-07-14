# omni-model AI proxy — Firebase Extension

Call **OpenAI, Anthropic (Claude), and Google Gemini** from your app with **no backend**.
This extension packages [omni-model](https://github.com/tiepvuvan/omni-model) as two
OpenAI-compatible [callable Cloud Functions](https://firebase.google.com/docs/functions/callable),
protected by Firebase Auth and App Check, with per-user rate limits stored in Firestore.

```
app  ──httpsCallable──▶  ext-<id>-chat / -embeddings  ──▶  OpenAI | Anthropic | Gemini
        (Auth + App Check verified)      (routing + rate limits + streaming)
```

## What you get

- **`ext-<instance-id>-chat`** — OpenAI-compatible chat completions, with streaming
  via the callable `.stream()` protocol.
- **`ext-<instance-id>-embeddings`** — OpenAI-compatible embeddings.
- Provider routing (default provider now; full CEL routing via the advanced config).
- Per-user **requests/minute** and **daily token budget**, tracked in Firestore
  (fail-open: a storage blip never takes the proxy down).
- Client identity from **Firebase Auth**; anti-abuse from **App Check** — both enforced
  by the callable protocol *and* re-checked in the adapter (defense in depth).

## Configuration parameters

| Param | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `LOCATION` | select (immutable) | `us-central1` | Region to deploy the functions to. Cannot be changed after install. |
| `OPENAI_API_KEY` | secret | — | OpenAI API key. Optional, but at least one provider key is required. |
| `ANTHROPIC_API_KEY` | secret | — | Anthropic (Claude) API key. Optional. |
| `GEMINI_API_KEY` | secret | — | Google Gemini API key. Optional. |
| `DEFAULT_PROVIDER` | select | `openai` | Provider used when no route matches. Falls back to the first configured provider if its key is absent. |
| `REQUESTS_PER_MINUTE` | string (int) | `60` | Per-user request limit per minute. |
| `DAILY_TOKEN_BUDGET` | string (int) | `200000` | Per-user token budget per day. |
| `REQUIRE_APP_CHECK` | select | `true` | Require a valid App Check token. |
| `REQUIRE_AUTH` | select | `true` | Require a signed-in Firebase user. |
| `FIRESTORE_COLLECTION` | string | `omni_ratelimits` | Firestore collection for rate-limit counters. |
| `ADVANCED_CONFIG_YAML` | string | — | Full `omni.yaml` override (custom routing / extra OpenAI-compatible providers). When set, it supersedes all provider/rate-limit/storage params. |

> Integer and boolean params are strings/selects because the Firebase Extensions param
> system only supports `string`, `select`, `multiSelect`, `secret`, and `selectresource`.

### Advanced configuration

Set `ADVANCED_CONFIG_YAML` to a complete omni-model configuration to unlock CEL-based
routing, tiered rate limits, or extra OpenAI-compatible upstreams. It supports `${ENV}`
interpolation against the function environment (so you can reference the secret params).
See the [configuration reference](https://github.com/tiepvuvan/omni-model/blob/main/docs/configuration.md).

## Client usage

The deployed callable name is `ext-<instance-id>-<function>` (e.g.
`ext-omni-model-proxy-chat`). Requests carry an OpenAI request body; do not set `stream`
in the body — streaming is chosen by calling `.stream()`.

### Web / JavaScript

```js
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(app, "us-central1"); // match LOCATION
const chat = httpsCallable(functions, "ext-omni-model-proxy-chat");

const { stream, data } = await chat.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Say hi in five words." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}
const final = await data; // aggregated chat.completion
```

### iOS / Swift

```swift
import FirebaseFunctions

let functions = Functions.functions(region: "us-central1")
let chat = functions.httpsCallable("ext-omni-model-proxy-chat")

let result = try await chat.call([
  "model": "gpt-4o-mini",
  "messages": [["role": "user", "content": "Hello!"]],
])
// Streaming: use `chat.stream(...)` on SDK versions that support callable streaming.
```

### Android / Kotlin

```kotlin
val functions = Firebase.functions("us-central1")
val chat = functions.getHttpsCallable("ext-omni-model-proxy-chat")

val data = hashMapOf(
  "model" to "gpt-4o-mini",
  "messages" to listOf(mapOf("role" to "user", "content" to "Hello!")),
)
val result = chat.call(data).await()
// Streaming: use `stream(...)` on SDK versions that support callable streaming.
```

App Check and Auth tokens are attached automatically once you initialize both in the app.

## Local development & testing

Test the extension in the [Extensions Emulator](https://firebase.google.com/docs/extensions/local-development)
**before publishing**:

```sh
# From the extension directory:
cd extensions/omni-model-proxy/functions
pnpm install
pnpm build            # esbuild bundles src/index.ts -> lib/index.js

# From a test Firebase project that points at this local source:
firebase ext:install ./extensions/omni-model-proxy --local
firebase emulators:start
```

The build bundles the `@omni-model/*` packages (they are not published to npm) and
leaves `firebase-admin` / `firebase-functions` external — the Cloud Functions runtime
provides them.

> **2nd-gen callable caveat.** This extension declares its functions as 2nd-gen
> (`v2function`) with an `httpsTrigger` and exports `onCall` handlers, so the callable
> protocol verifies Auth + App Check. Callable-in-extension behavior differs between
> 1st and 2nd gen — always exercise both the `chat` and `embeddings` callables in the
> emulator (streaming and non-streaming, with a real App Check token) before you publish.

## How it works

- `functions/src/config.ts` turns the extension params into a validated omni-model
  `OmniConfig` (or parses `ADVANCED_CONFIG_YAML` directly).
- `functions/src/index.ts` initializes the Admin SDK, lazily builds the callables via
  `@omni-model/firebase`'s `createOmniCallables`, and exports `chat` and `embeddings`
  as `onCall` handlers, translating adapter `CallableError`s into `HttpsError`s.

## License

Apache-2.0.
