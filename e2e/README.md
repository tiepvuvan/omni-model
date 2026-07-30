# End-to-end tests

These exercise the **whole chain** — the omni-model proxy, its operator API, external identity and
application-verification services, and both Swift integrations — so a regression anywhere
(routing, translation, streaming, auth, configuration reload, or the Foundation Models executor)
fails a test instead of a shipped app.

The deterministic application-verification suite is ungated. Live-provider suites have independent
credential and platform gates because they need external infrastructure:

| Gate | Suites | Cost |
| --- | --- | --- |
| none | `application-verification`, `user-authentication` | Free. Real Node HTTP servers with deterministic identity/vendor and model endpoints. |
| `TEST_POSTGRES_URL` | `admin-api`, `config-reload` | Free. A real database, no upstream. |
| `OPENROUTER_API_KEY` | `openrouter-chat`, `auth-apple` | A few tenths of a cent. |
| Firebase environment | `live-providers/firebase` | Free. Real Firebase tokens; the model upstream is deterministic. |
| reCAPTCHA Enterprise environment | `live-providers/recaptcha-enterprise` | Google assessment usage; the model upstream is deterministic and free. |

The database-backed ones run in CI on every push. For the upstream ones, get an
[OpenRouter](https://openrouter.ai) key:

```sh
OPENROUTER_API_KEY=sk-or-... e2e/run.sh
```

The database-backed ones on their own:

```sh
pnpm test:pg:up && TEST_POSTGRES_URL=postgres://omni:secret@localhost:55432/omni_test pnpm test:e2e
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

## Live Firebase Authentication and App Check

The suite at `e2e/live-providers/firebase.e2e.test.ts` reaches the real Identity Toolkit, Firebase
Auth JWKS, App Check token exchange, App Check JWKS, and—when enabled—the Admin replay-protection
endpoint. User and application credentials are verified by a real omni-model server, while the
model upstream stays deterministic and free.

Its checks are independently gated:

1. **Firebase Auth** exchanges a service-account custom token for a genuine client ID token,
   rejects missing and tampered tokens, reaches routing, and deletes the disposable test user.
2. **Firebase App Check** exchanges a registered debug secret for a genuine App Check token,
   rejects a bogus token, enforces the app-id allowlist, and reaches routing.
3. **Combined layers** prove that Firebase Auth and App Check are both required on the same request.
4. **Replay protection** optionally requests a limited-use token, consumes it, and proves reuse is
   rejected.

Initialize Firebase Authentication once in the Firebase console. A service-account fixture does
not require enabling Anonymous sign-in; without one, the suite falls back to an anonymous user and
that provider must be enabled.

For App Check, register the client app and a dedicated debug token under Firebase console →
App Check → Apps → Manage debug tokens. Treat that token as a secret: it bypasses device
attestation for the registered app.

### Configure a local run

Copy the template outside the repository and load it:

```sh
cp e2e/firebase.env.example /tmp/omni-firebase.env
chmod 600 /tmp/omni-firebase.env
set -a
. /tmp/omni-firebase.env
set +a
```

The identifiers come from `GoogleService-Info.plist`, `google-services.json`, or the Firebase Web
configuration:

- `FIREBASE_API_KEY` — client API key
- `FIREBASE_PROJECT_ID` — textual project id used by Firebase Auth
- `FIREBASE_PROJECT_NUMBER` — numeric project number used by App Check
- `FIREBASE_APP_ID` — the exact Web, Android, or iOS app registered for the debug token
- `FIREBASE_APPCHECK_DEBUG_TOKEN_FILE` — mode-`0600` registered debug secret
- `GOOGLE_APPLICATION_CREDENTIALS` — preferred disposable-user fixture and replay credentials

Run only the live Firebase suite:

```sh
pnpm test:e2e -- e2e/live-providers/firebase.e2e.test.ts
```

To verify limited-use-token consumption, grant the runtime service account
`roles/firebaseappcheck.tokenVerifier` and set:

```sh
export FIREBASE_APPCHECK_TEST_CONSUME=true
```

Require every check in a coordinated CI job:

```sh
export OMNI_E2E_REQUIRE_FIREBASE=auth,app-check,combined,replay-protection
```

With the strict gate, missing Firebase inputs or a disabled replay check fail discovery instead of
silently skipping coverage.

## Live reCAPTCHA Enterprise: Web, Android, and iOS

The default application-verification suite uses deterministic vendor responses. The live suite at
`e2e/live-providers/recaptcha-enterprise.e2e.test.ts` keeps the user token and model upstream local
but sends the assessment through omni-model to the real Google API.

Each configured platform runs:

1. A repeatable invalid-token preflight. A `401` proves the credential, project, key, OAuth/API-key
   path, and assessment API are reachable. A `503` fails with IAM/API guidance.
2. A fresh-token acceptance test. It verifies token validity, the `LOGIN` action, score presence,
   platform origin allowlisting, routing, and the deterministic completion.

Google tokens are one-time and expire after two minutes. They are never suitable as stored CI
secrets. A browser or the platform SDK must mint one during the job.

### GCP permissions and keys

The runtime service account needs `roles/recaptchaenterprise.agent`, which includes
`recaptchaenterprise.assessments.create`. Key creation is a separate administrative operation; use
an operator with `roles/recaptchaenterprise.admin` rather than granting that role to the runtime.

Create one key per platform and environment:

```sh
gcloud recaptcha keys create \
  --display-name=omni-e2e-ios \
  --ios \
  --bundle-ids=com.example.omni

gcloud recaptcha keys create \
  --display-name=omni-e2e-android \
  --android \
  --package-names=com.example.omni \
  --testing-score=0.9
```

The existing Web score key can be used when it allows `localhost`. For a dedicated test key:

```sh
gcloud recaptcha keys create \
  --display-name=omni-e2e-web \
  --web \
  --domains=localhost \
  --integration-type=score \
  --testing-score=0.9
```

### Configure a local run

Copy the template outside the repository, fill only the platforms you are testing, then load it:

```sh
cp e2e/recaptcha-enterprise.env.example /tmp/omni-recaptcha-enterprise.env
set -a
. /tmp/omni-recaptcha-enterprise.env
set +a
```

Use exactly one backend credential:

- `GOOGLE_APPLICATION_CREDENTIALS` pointing at service-account JSON, read by this test harness
- `RECAPTCHA_ENTERPRISE_SERVICE_ACCOUNT_KEY` containing the JSON
- `RECAPTCHA_ENTERPRISE_API_KEY` containing a server API key authorized for assessments

No credential or token file is read unless its gate is configured.

### Web token and test

Start the token handoff:

```sh
pnpm recaptcha:web-token
```

Open the printed localhost URL. The page executes the configured action, writes the token to
`RECAPTCHA_ENTERPRISE_WEB_TOKEN_FILE` with mode `0600`, never prints it, and exits. Immediately run:

```sh
pnpm test:e2e -- e2e/live-providers/recaptcha-enterprise.e2e.test.ts
```

### Android and iOS tokens

Use the reCAPTCHA Enterprise mobile SDK for the platform key and configured action. The relevant
SDK calls are:

```kotlin
val client = Recaptcha.fetchClient(application, siteKey)
val token = client.execute(RecaptchaAction.LOGIN)
```

```swift
let client = try await Recaptcha.fetchClient(withSiteKey: siteKey)
let token = try await client.execute(withAction: RecaptchaAction.login)
```

Transfer the fresh token through the test runner's secure device-to-host channel and write it to
`RECAPTCHA_ENTERPRISE_ANDROID_TOKEN_FILE` or `RECAPTCHA_ENTERPRISE_IOS_TOKEN_FILE`. Run the same
test command within two minutes. Direct `*_TOKEN` variables are also supported for device-oriented
CI, but files avoid shell history and process-list exposure. Follow Google's
[Android SDK](https://cloud.google.com/recaptcha/docs/instrument-android-apps) and
[iOS SDK](https://cloud.google.com/recaptcha/docs/instrument-ios-apps) setup guides for dependency
and platform requirements.

Set a strict gate in a coordinated on-device job:

```sh
export OMNI_E2E_REQUIRE_RECAPTCHA_PLATFORMS=web,android,ios
```

With that flag, a missing project, credential, site key, origin, or fresh token fails test discovery
instead of silently skipping the platform.

## What runs

| Suite | Command | Covers |
| --- | --- | --- |
| **Admin API** | `pnpm test:e2e` | The operator journey from an **empty database**, over HTTP: first-run sign-up, storing an encrypted credential, configuring the proxy from nothing, minting a write key, a real request needing both a client key and a user token, finding it in the logs with token counts, revoking the key, and an append-only rollback. Needs `TEST_POSTGRES_URL`. |
| **Config reload** | `pnpm test:e2e` | **Two instances, one database**: a revision saved on one reaches the other with no restart, a rejected revision leaves both serving the previous one, an in-flight stream finishes on the bundle it started with, and rate-limit counters are shared rather than per instance. Needs `TEST_POSTGRES_URL`. |
| **Application verification** | `pnpm test:e2e` | A real `@omni-model/node` HTTP server accepts Turnstile, reCAPTCHA Enterprise, and Play Integrity proofs through their production verifiers, reaches the model upstream, and rejects an invalid proof before routing. Vendor calls are deterministic fakes, so this always runs offline. |
| **Live Firebase** | `pnpm test:e2e` | Real Firebase Auth and App Check credentials pass their production verifiers, both layers are required together, disposable users are deleted, and optional limited-use-token replay protection is enforced. Needs the Firebase environment above; no model key. |
| **Live reCAPTCHA Enterprise** | `pnpm test:e2e` | A real proxy creates real Google assessments for Web, Android, and iOS keys. Invalid-token preflights require only the site key; full acceptance additionally requires a fresh SDK token and platform origin. Needs the reCAPTCHA environment above. |
| **User authentication** | `pnpm test:e2e` | Real Node HTTP servers validate Clerk and Cognito JWTs through their production JWKS verifiers, reach the model upstream for accepted users, and reject a token for another Cognito app client before routing. Always runs offline. |
| **Proxy** | `pnpm test:e2e` | Real `@omni-model/node` container → OpenRouter: chat, **streaming**, a **tool-calling round-trip**, usage, and an upstream-error case. |
| **Apple auth** | `pnpm test:e2e` | **DeviceCheck** server side (the proxy's ES256 JWT is accepted by Apple → Team/Key/`.p8` valid) and the **App Attest** challenge route, with the Firebase verifiers alongside under `mode: "any"`. Needs Apple env (above). Device-signed tokens themselves are verified via the example iOS app's on-device screen. |
| **MacPaw** | `swift test` in `swift/OmniModelClientKit` (macOS) | MacPaw/OpenAI client + `OmniAuthMiddleware` → proxy: chat + streaming. |
| **Foundation Models** | `xcodebuild test` in `swift/OmniModelFoundation` (iOS 27 sim) | `LanguageModelSession` → `OmniProxyExecutor` → proxy: `respond` + streaming. |

`e2e/run.sh` runs all of them. `pnpm test:e2e` covers the JavaScript ones, each booting its own
ephemeral server. The Swift suites talk to a proxy the script starts on `http://localhost:8788` (the
iOS simulator reaches the host's `localhost`).

## Self-guarding

- The admin-API and config-reload suites **skip themselves** without `TEST_POSTGRES_URL`. CI's
  integration job supplies one, so they run on every push.
- The application-verification and user-authentication suites are never skipped and need no secret
  or external service.
- The live Firebase suite gates Auth, App Check, their combined policy, and replay protection
  independently. Set `OMNI_E2E_REQUIRE_FIREBASE` to make selected checks mandatory.
- The live reCAPTCHA suite skips without a project, one backend credential, and a platform site key.
  Set `OMNI_E2E_REQUIRE_RECAPTCHA_PLATFORMS` in a live-provider job to turn missing platform inputs
  into a failure.
- The proxy E2E test **skips itself** when `OPENROUTER_API_KEY` is unset — so `pnpm test:e2e` is a
  no-op in CI without the secret, and the default `pnpm test` never includes these (separate
  `vitest.e2e.config.ts`).
- The Apple-auth test **skips itself** without `APPLE_TEAM_ID` + `APPLE_DEVICECHECK_KEY` (+ key id,
  bundle id, Firebase project ids).
- The Swift E2E tests **skip themselves** when no proxy is reachable on `:8788`, so `swift test` /
  `xcodebuild test` stay green offline (only the fast unit tests run).

Never commit a key. The e2e JSON documents reference `${OPENROUTER_API_KEY}` and the suites provide
it through the environment, so it is never written to any file. Firebase debug tokens and
reCAPTCHA proofs belong in explicitly configured temporary files with mode `0600`.
