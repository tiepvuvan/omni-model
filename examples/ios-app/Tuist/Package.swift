// swift-tools-version: 6.0
import PackageDescription

#if TUIST
  import struct ProjectDescription.PackageSettings

  let packageSettings = PackageSettings(
    // Firebase ships static frameworks; build its modules as static so the
    // resource bundles resolve correctly under Tuist.
    productTypes: [
      "OpenAI": .framework,
    ]
  )
#endif

let package = Package(
  name: "OmniModelExample",
  dependencies: [
    .package(url: "https://github.com/firebase/firebase-ios-sdk", from: "11.0.0"),
    .package(url: "https://github.com/MacPaw/OpenAI", from: "0.4.0"),
  ]
)
