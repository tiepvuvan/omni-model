// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "OmniModelClientKit",
  platforms: [
    .iOS("16.0"),
    .macOS("13.0"),
    .visionOS("1.0"),
  ],
  products: [
    .library(name: "OmniModelClientKit", targets: ["OmniModelClientKit"]),
  ],
  dependencies: [
    .package(url: "https://github.com/MacPaw/OpenAI", from: "0.4.0"),
  ],
  targets: [
    .target(
      name: "OmniModelClientKit",
      dependencies: [.product(name: "OpenAI", package: "OpenAI")]
    ),
    .testTarget(
      name: "OmniModelClientKitTests",
      dependencies: ["OmniModelClientKit"]
    ),
  ]
)
