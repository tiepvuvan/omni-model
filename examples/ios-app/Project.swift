import ProjectDescription

// Bundle id + signing team come from the environment so the repo stays generic
// and your identifiers are never committed. App Attest + DeviceCheck need a real
// device signed by a real team, and the bundle id must match the one registered
// in Firebase (and used by apple-app-attest.bundleId on the proxy):
//
//   TUIST_OMNI_BUNDLE_ID=co.unstatic.polyplan \
//   TUIST_OMNI_DEVELOPMENT_TEAM=ABCDE12345 \
//   tuist generate
//
let bundleId = Environment.omniBundleId.getString(default: "com.omnimodel.example")
let developmentTeam = Environment.omniDevelopmentTeam.getString(default: "")

let signingSettings: SettingsDictionary =
  developmentTeam.isEmpty ? [:] : ["DEVELOPMENT_TEAM": .string(developmentTeam)]

let project = Project(
  name: "OmniModelExample",
  targets: [
    .target(
      name: "OmniModelExample",
      destinations: .iOS,
      product: .app,
      bundleId: bundleId,
      deploymentTargets: .iOS("16.0"),
      infoPlist: .extendingDefault(with: [
        "UILaunchScreen": [:],
        "CFBundleDisplayName": "omni-model",
      ]),
      sources: ["Sources/**"],
      resources: ["Resources/**"],
      entitlements: .dictionary([
        // Required for App Attest. "development" matches a debug build run from
        // Xcode onto a device; use "production" for TestFlight/App Store (and set
        // apple-app-attest.environment: production on the proxy to match).
        "com.apple.developer.devicecheck.appattest-environment": .string("development"),
      ]),
      dependencies: [
        .external(name: "FirebaseAuth"),
        .external(name: "FirebaseAppCheck"),
        .external(name: "OpenAI"),
      ],
      settings: .settings(base: signingSettings)
    ),
  ]
)
