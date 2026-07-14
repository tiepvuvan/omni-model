# omni-model — example iOS app

A minimal SwiftUI app that streams a chat completion from a self-hosted omni-model
proxy using the real [MacPaw/OpenAI](https://github.com/MacPaw/OpenAI) client plus the
`OmniAuthMiddleware` from [`../ios/OmniModelClient.swift`](../ios/OmniModelClient.swift)
(symlinked into `Sources/` so this app builds the exact shipped file).

The project is generated with [Tuist](https://tuist.dev) and pulls its dependencies
(Firebase, MacPaw/OpenAI) via Swift Package Manager.

## Run it

```sh
cd examples/ios-app
tuist install      # resolve Firebase + MacPaw/OpenAI
tuist generate     # create OmniModelExample.xcworkspace
open OmniModelExample.xcworkspace
```

Then, before it does anything real:

1. **Point it at your proxy** — edit `OmniEndpoint.production` in
   [`../ios/OmniModelClient.swift`](../ios/OmniModelClient.swift).
2. **Pick your auth** — `Sources/ContentView.swift` uses `FirebaseAppCheckAuth()` by
   default. Swap it for `FirebaseIDTokenAuth()`, `BearerTokenAuth { … }`,
   `AppAttestAuth()`, or `DeviceCheckAuth()` to match your proxy's `security.providers`.
3. **Add Firebase config** — replace `Resources/GoogleService-Info.plist` with your own
   from the Firebase console. (The bundled one is a build-only placeholder.) If you use
   `BearerTokenAuth`, remove the Firebase bits from `Sources/App.swift` instead.

## Build from the command line

```sh
tuist generate --no-open
xcodebuild -workspace OmniModelExample.xcworkspace -scheme OmniModelExample \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
```

This is what CI/verification runs — it compiles `OmniModelClient.swift` against the real
MacPaw/OpenAI + Firebase SDKs.

## Layout

```
Project.swift            Tuist target (app + external deps)
Tuist/Package.swift      SPM dependencies (firebase-ios-sdk, MacPaw/OpenAI)
Sources/App.swift        @main app; installs the App Check provider factory
Sources/ContentView.swift  streaming chat screen
Sources/OmniModelClient.swift  → symlink to ../ios/OmniModelClient.swift
Resources/GoogleService-Info.plist  placeholder — replace with yours
```
