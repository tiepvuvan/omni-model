import ProjectDescription

let project = Project(
  name: "OmniModelExample",
  targets: [
    .target(
      name: "OmniModelExample",
      destinations: .iOS,
      product: .app,
      bundleId: "com.omnimodel.example",
      deploymentTargets: .iOS("16.0"),
      infoPlist: .extendingDefault(with: [
        "UILaunchScreen": [:],
        "CFBundleDisplayName": "omni-model",
      ]),
      sources: ["Sources/**"],
      resources: ["Resources/**"],
      dependencies: [
        .external(name: "FirebaseAuth"),
        .external(name: "FirebaseAppCheck"),
        .external(name: "OpenAI"),
      ]
    ),
  ]
)
