# OmniModelFoundation

A [Foundation Models](https://developer.apple.com/documentation/foundationmodels) `LanguageModel`
package that routes generation through a self-hosted [omni-model](https://github.com/tiepvuvan/omni-model)
proxy. Because it conforms to the framework's public `LanguageModel` / `LanguageModelExecutor`
protocols, your app calls it with the exact same `LanguageModelSession` API it uses for Apple's
on-device model — just swap the model in.

- **Zero dependencies.** Only Foundation + system frameworks (DeviceCheck, ImageIO, CryptoKit).
- **Streaming** chat, **vision** (images in prompts are forwarded as data URLs), and `GenerationOptions`
  (`temperature`, `maximumResponseTokens`) mapped to the OpenAI wire format.
- **Auth built in** — bearer / custom-header / App Attest / DeviceCheck, matching the proxy's
  `security.providers`. (Firebase App Check: fetch the token yourself and pass it via
  `CustomHeaderAuth`.)
- **Errors** map onto `LanguageModelError` (rate limits, context overflow, timeouts, guardrails).

Requires iOS/macOS/visionOS/watchOS **27+** (the `LanguageModel` protocol ships in the 27 SDKs).

## Install

Add the package in Xcode (**File → Add Package Dependencies…**) or in `Package.swift`:

```swift
.package(url: "https://github.com/<owner>/OmniModelFoundation", from: "0.1.0")
```

> This package lives in the omni-model monorepo under `swift/OmniModelFoundation`. To distribute it
> by URL, publish this directory as its own repository (SwiftPM resolves a package from a repo root),
> or add it as a local package (`.package(path: "…/swift/OmniModelFoundation")`).

## Use it

```swift
import FoundationModels
import OmniModelFoundation

let model = OmniProxyModel(
  endpoint: OmniEndpoint("https://ai.example.com"),
  model: "gpt-4o-mini",                       // a model id, or a routing alias like "smart"
  auth: BearerTokenAuth { try await myAuth.freshToken() }
)

let session = LanguageModelSession(model: model) {
  "You are a helpful assistant."
}

// One-shot
let reply = try await session.respond(to: "Write a haiku about the sea.")
print(reply.content)

// Streaming
for try await partial in session.streamResponse(to: "Tell me a short story.") {
  print(partial.content)
}
```

Swap `auth:` for your proxy's verifier:

| Provider | Header | omni-model verifier |
| --- | --- | --- |
| `BearerTokenAuth { … }` | `Authorization: Bearer` | `jwt` / `firebase-auth` / `supabase` |
| `CustomHeaderAuth(header: "X-Firebase-AppCheck") { … }` | `X-Firebase-AppCheck` | `firebase-app-check` |
| `AppAttestAuth(endpoint:)` | `x-appattest-*` | `apple-app-attest` |
| `DeviceCheckAuth()` | `X-Apple-Device-Token` | `apple-device-check` |

## Scope

Supported today: streaming text, vision (image attachments), instructions/system prompts, and the
common `GenerationOptions`. Tool calling and guided generation are handled by the upstream model but
not yet surfaced as first-class Foundation Models capabilities; prior tool-call and reasoning
transcript entries are not replayed upstream.

## Develop

```sh
cd swift/OmniModelFoundation
swift build                                   # compiles against the FoundationModels SDK
xcodebuild test -scheme OmniModelFoundation \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0'
```
