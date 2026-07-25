# End-to-end tests

These exercise the **whole chain** — the omni-model proxy, its operator API, and both Swift
integrations — so a regression anywhere (routing, translation, streaming, auth, configuration
reload, the Foundation Models executor) fails a test instead of a shipped app.

There are two independent gates, because the suites need different things:

| Gate | Suites | Cost |
| --- | --- | --- |
| `TEST_POSTGRES_URL` | `admin-api`, `config-reload` | Free. A real database, no upstream. |
| `OPENROUTER_API_KEY` | `openrouter-chat`, `auth-firebase`, `auth-apple` | A few tenths of a cent. |

The database-backed ones run in CI on every push. For the upstream ones, get an
[OpenRouter](https://openrouter.ai) key:

```sh
OPENROUTER_API_KEY=sk-or-... e2e/run.sh
```

The database-backed ones on their own:

```sh
pnpm test:pg:up && TEST_POSTGRES_URL=postgres://omni:secret@localhost:55432/omni_test pnpm test:e2e
```

To also verify **Firebase Auth / App Check**, add the project's identifiers (from its
`GoogleService-Info.plist`) — the ID-token test needs the first three; App Check additionally needs a
registered [debug token](https://firebase.google.com/docs/app-check/ios/debug-provider):

```sh
export FIREBASE_API_KEY=...          # plist API_KEY (client key)
export FIREBASE_PROJECT_ID=...       # plist PROJECT_ID
export FIREBASE_PROJECT_NUMBER=...   # plist GCM_SENDER_ID
export FIREBASE_APP_ID=...           # plist GOOGLE_APP_ID   (App Check only)
export FIREBASE_APPCHECK_DEBUG_TOKEN=...  #                  (App Check only)
```

To also verify the **Apple** verifiers' server side (DeviceCheck config + App Attest route), add your
Apple Team + DeviceCheck key (the shared device-auth config also interpolates the Firebase project
ids above):

```sh
export APPLE_TEAM_ID=...              # 10-char Apple Developer team id
export APPLE_BUNDLE_ID=...           # app bundle id (apple-app-attest.bundleId)
export APPLE_DEVICECHECK_KEY_ID=...  # App Store Connect DeviceCheck key id
export APPLE_DEVICECHECK_KEY="$(cat AuthKey_XXXX.p8)"  # the .p8 PKCS8 PEM contents
export FIREBASE_PROJECT_ID=...       # plist PROJECT_ID
export FIREBASE_PROJECT_NUMBER=...   # plist GCM_SENDER_ID
```

## What runs

| Suite | Command | Covers |
| --- | --- | --- |
| **Admin API** | `pnpm test:e2e` | The operator journey from an **empty database**, over HTTP: first-run sign-up, storing an encrypted credential, configuring the proxy from nothing, minting a write key, a real request needing both a client key and a user token, finding it in the logs with token counts, revoking the key, and an append-only rollback. Needs `TEST_POSTGRES_URL`. |
| **Config reload** | `pnpm test:e2e` | **Two instances, one database**: a revision saved on one reaches the other with no restart, a rejected revision leaves both serving the previous one, an in-flight stream finishes on the bundle it started with, and rate-limit counters are shared rather than per instance. Needs `TEST_POSTGRES_URL`. |
| **Proxy** | `pnpm test:e2e` | Real `@omni-model/node` container → OpenRouter: chat, **streaming**, a **tool-calling round-trip**, usage, and an upstream-error case. |
| **Firebase auth** | `pnpm test:e2e` | **Firebase Auth** (and **App Check**): a REAL ID token minted from the project via Identity Toolkit is accepted (200); no/forged credential is rejected (401). Needs Firebase env (above). |
| **Apple auth** | `pnpm test:e2e` | **DeviceCheck** server side (the proxy's ES256 JWT is accepted by Apple → Team/Key/`.p8` valid) and the **App Attest** challenge route, with the Firebase verifiers alongside under `mode: "any"`. Needs Apple env (above). Device-signed tokens themselves are verified via the example iOS app's on-device screen. |
| **MacPaw** | `swift test` in `swift/OmniModelClientKit` (macOS) | MacPaw/OpenAI client + `OmniAuthMiddleware` → proxy: chat + streaming. |
| **Foundation Models** | `xcodebuild test` in `swift/OmniModelFoundation` (iOS 27 sim) | `LanguageModelSession` → `OmniProxyExecutor` → proxy: `respond` + streaming. |

`e2e/run.sh` runs all of them. `pnpm test:e2e` covers the JavaScript ones, each booting its own
ephemeral server. The Swift suites talk to a proxy the script starts on `http://localhost:8788` (the
iOS simulator reaches the host's `localhost`).

## Self-guarding

- The admin-API and config-reload suites **skip themselves** without `TEST_POSTGRES_URL`. CI's
  integration job supplies one, so they run on every push.
- The proxy E2E test **skips itself** when `OPENROUTER_API_KEY` is unset — so `pnpm test:e2e` is a
  no-op in CI without the secret, and the default `pnpm test` never includes these (separate
  `vitest.e2e.config.ts`).
- The Firebase-auth test **skips itself** without `FIREBASE_API_KEY`/`FIREBASE_PROJECT_ID`/
  `FIREBASE_PROJECT_NUMBER`; its App Check cases skip without `FIREBASE_APP_ID` +
  `FIREBASE_APPCHECK_DEBUG_TOKEN`.
- The Apple-auth test **skips itself** without `APPLE_TEAM_ID` + `APPLE_DEVICECHECK_KEY` (+ key id,
  bundle id, Firebase project ids).
- The Swift E2E tests **skip themselves** when no proxy is reachable on `:8788`, so `swift test` /
  `xcodebuild test` stay green offline (only the fast unit tests run).

Never commit a key. The e2e JSON documents reference `${OPENROUTER_API_KEY}` and the suites provide
it through the environment, so it is never written to any file.
