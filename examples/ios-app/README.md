# omni-model — example iOS app

A SwiftUI app that verifies **every** omni-model auth method against a running proxy, using the real
[MacPaw/OpenAI](https://github.com/MacPaw/OpenAI) client plus the `OmniAuthMiddleware` from
[`../ios/OmniModelClient.swift`](../ios/OmniModelClient.swift) (symlinked into `Sources/` so this app
builds the exact shipped file).

The **Auth verification** screen (`Sources/ContentView.swift`) has one row per method — Firebase
Auth, Firebase App Check, DeviceCheck, App Attest — and a Worker/container target switch. Each row
refreshes an `OmniAuthBox` from that provider, sends a real chat, and reports **PASS**/**FAIL**. Point
it at your deployed Worker and container URLs and tap **Run all** to prove both runtimes enforce auth
identically.

> App Attest and DeviceCheck use the Secure Enclave — they only work on a **real device** (they
> report "unsupported" on the simulator). See [Verify auth on a real device](../../docs/security/verify-on-device.mdx)
> for the full flow, including the matching proxy config.

The project is generated with [Tuist](https://tuist.dev) and pulls Firebase + MacPaw/OpenAI via SPM.

## Run it on a device

```sh
cd examples/ios-app
tuist install                                   # resolve Firebase + MacPaw/OpenAI

# Your identifiers are read from the environment so they're never committed. The
# bundle id must match apple-app-attest.bundleId on the proxy and the Firebase app;
# the team must own the DeviceCheck key.
TUIST_OMNI_BUNDLE_ID=co.unstatic.polyplan \
TUIST_OMNI_DEVELOPMENT_TEAM=ABCDE12345 \
  tuist generate

open OmniModelExample.xcworkspace
```

Then:

1. **Replace `Resources/GoogleService-Info.plist`** with your project's (the bundled one is a
   build-only placeholder — don't commit yours).
2. **Run on a real device**, paste your Worker + container URLs into the screen, and **Run all**.

The App Attest entitlement (`appattest-environment: development`) is already wired in `Project.swift`;
flip it (and the proxy's `apple-app-attest.environment`) to `production` for a TestFlight/App Store
build.

## Build from the command line (compile check)

```sh
tuist generate --no-open
xcodebuild -workspace OmniModelExample.xcworkspace -scheme OmniModelExample \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
```

This is what verification runs — it compiles the screen + all four providers against the real
MacPaw/OpenAI + Firebase + DeviceCheck SDKs. (It can't *run* App Attest/DeviceCheck — that needs a
device.)

## Layout

```
Project.swift            Tuist target — bundle id/team from TUIST_OMNI_* env; App Attest entitlement
Tuist/Package.swift      SPM dependencies (firebase-ios-sdk, MacPaw/OpenAI)
Sources/App.swift        @main app; installs the App Check provider factory + Firebase.configure()
Sources/ContentView.swift  the Auth verification matrix (all four methods, two targets)
Sources/OmniModelClient.swift  → symlink to ../ios/OmniModelClient.swift
Resources/GoogleService-Info.plist  placeholder — replace with yours
```
