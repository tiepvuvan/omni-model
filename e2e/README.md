# End-to-end tests

These exercise the **whole chain** against a real upstream — the omni-model proxy plus both Swift
integrations — so a regression anywhere (routing, translation, streaming, auth, the Foundation
Models executor) fails a test instead of a shipped app.

They're **opt-in** and cost a few tenths of a cent (tiny prompts, `openai/gpt-4o-mini`). Get an
[OpenRouter](https://openrouter.ai) key, then:

```sh
OPENROUTER_API_KEY=sk-or-... e2e/run.sh
```

To also verify **Firebase Auth / App Check**, add the project's identifiers (from its
`GoogleService-Info.plist`) — the ID-token test needs the first four; App Check additionally needs a
registered [debug token](https://firebase.google.com/docs/app-check/ios/debug-provider):

```sh
export FIREBASE_API_KEY=...          # plist API_KEY (client key)
export FIREBASE_PROJECT_ID=...       # plist PROJECT_ID
export FIREBASE_PROJECT_NUMBER=...   # plist GCM_SENDER_ID
export FIREBASE_APP_ID=...           # plist GOOGLE_APP_ID   (App Check only)
export FIREBASE_APPCHECK_DEBUG_TOKEN=...  #                  (App Check only)
```

To also verify the **Apple** verifiers' server side (DeviceCheck config + App Attest route), add your
Apple Team + DeviceCheck key:

```sh
export APPLE_TEAM_ID=...              # 10-char Apple Developer team id
export APPLE_BUNDLE_ID=...           # app bundle id (apple-app-attest.bundleId)
export APPLE_DEVICECHECK_KEY_ID=...  # App Store Connect DeviceCheck key id
export APPLE_DEVICECHECK_KEY="$(cat AuthKey_XXXX.p8)"  # the .p8 PKCS8 PEM contents
```


## What runs

| Suite | Command | Covers |
| --- | --- | --- |
| **Node** | `pnpm test:e2e` | Real `@omni-model/node` server → OpenRouter: chat, **streaming**, a **tool-calling round-trip**, usage, and an upstream-error case. |
| **Cloudflare Worker** | `pnpm test:e2e` | The real worker running in **workerd** (`wrangler dev`) → OpenRouter: boots + parses config, chat, **SSE streaming through workerd**, and **Durable Object** rate limiting (a burst trips a 429). |
| **Firebase auth** | `pnpm test:e2e` | **Firebase Auth** (and **App Check**) verified on BOTH targets (Node + workerd): a REAL ID token minted from the project via Identity Toolkit is accepted (200); no/forged credential is rejected (401). Needs Firebase env (below). |
| **Apple auth** | `pnpm test:e2e` | **DeviceCheck** server side (the proxy's ES256 JWT is accepted by Apple → Team/Key/`.p8` valid) and the **App Attest** challenge route, on both targets. Needs Apple env (below). Device-signed tokens themselves are verified via the example iOS app's on-device screen. |
| **Firestore storage** | Firestore emulator (below) | The Node server (the Cloud Run backend) with `storage: firestore`: boots via firebase-admin and enforces rate limits from **Firestore counters** (a burst trips a 429). Runs against the local Firestore emulator, so no GCP needed. |
| **MacPaw** | `swift test` in `swift/OmniModelClientKit` (macOS) | MacPaw/OpenAI client + `OmniAuthMiddleware` → proxy: chat + streaming. |
| **Foundation Models** | `xcodebuild test` in `swift/OmniModelFoundation` (iOS 27 sim) | `LanguageModelSession` → `OmniProxyExecutor` → proxy: `respond` + streaming. |

`e2e/run.sh` runs all of them. `pnpm test:e2e` covers the first two: the Node suite boots its own
ephemeral server, and the Worker suite (`cloudflare-worker.e2e.test.ts`) starts `wrangler dev` on
`http://127.0.0.1:8799` in a subprocess — running the genuine `createWorker` + `OmniStorageDurableObject`
from `e2e/cloudflare/` (requires a prior `pnpm build`), passing the key via `--var` so it never
touches disk, and tearing the process group down on exit. The Swift suites talk to a proxy the script
starts on `http://localhost:8788` (the iOS simulator reaches the host's `localhost`).

## Firestore storage (emulator)

The Firestore-storage test runs the Node server (the Cloud Run backend) against the local Firestore
emulator — no GCP account needed (just the [Firebase CLI](https://firebase.google.com/docs/cli) and a
JRE):

```sh
firebase emulators:start --only firestore --project omni-e2e &   # start it (default port 8080)
FIRESTORE_EMULATOR_HOST=localhost:8080 GOOGLE_CLOUD_PROJECT=omni-e2e OPENROUTER_API_KEY=sk-or-... \
  pnpm exec vitest run --config vitest.e2e.config.ts e2e/storage-firestore.e2e.test.ts
```

`@omni-model/node` builds a credentialed Firestore admin instance from the environment
(`FIRESTORE_EMULATOR_HOST` for the emulator; Application Default Credentials + `GOOGLE_CLOUD_PROJECT`
on Cloud Run), so the same config verified here deploys unchanged.

## Self-guarding

- The Node and Worker E2E tests **skip themselves** when `OPENROUTER_API_KEY` is unset — so
  `pnpm test:e2e` is a no-op in CI without the secret, and the default `pnpm test` never includes
  these (separate `vitest.e2e.config.ts`).
- The Firebase-auth test **skips itself** without `FIREBASE_API_KEY`/`FIREBASE_PROJECT_ID`/
  `FIREBASE_PROJECT_NUMBER`; its App Check cases skip without `FIREBASE_APP_ID` +
  `FIREBASE_APPCHECK_DEBUG_TOKEN`.
- The Apple-auth test **skips itself** without `APPLE_TEAM_ID` + `APPLE_DEVICECHECK_KEY` (+ key id,
  bundle id, Firebase project ids).
- The Firestore-storage test **skips itself** without `FIRESTORE_EMULATOR_HOST`, so it's a no-op in
  `pnpm test:e2e` unless the emulator is running.
- The Swift E2E tests **skip themselves** when no proxy is reachable on `:8788`, so `swift test` /
  `xcodebuild test` stay green offline (only the fast unit tests run).

Never commit a key. `omni.e2e.yaml` and `cloudflare/omni.e2e.worker.yaml` read `${OPENROUTER_API_KEY}`
from the environment; the Worker suite passes it to `wrangler dev --var`, so it is never written to a
`.dev.vars` (or any) file.
