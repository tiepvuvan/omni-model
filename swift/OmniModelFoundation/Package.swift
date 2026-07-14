// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "OmniModelFoundation",
  platforms: [
    .iOS("27.0"),
    .macOS("27.0"),
    .visionOS("27.0"),
    .watchOS("27.0"),
  ],
  products: [
    .library(name: "OmniModelFoundation", targets: ["OmniModelFoundation"]),
  ],
  targets: [
    // No external dependencies — every dependency is bytes a developer ships.
    .target(name: "OmniModelFoundation"),
    .testTarget(
      name: "OmniModelFoundationTests",
      dependencies: ["OmniModelFoundation"]
    ),
  ]
)
