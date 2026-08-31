// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "CodexRouterTray",
  defaultLocalization: "en",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "CodexRouterTray", targets: ["CodexRouterTray"]),
  ],
  targets: [
    .executableTarget(
      name: "CodexRouterTray",
      path: "Sources",
      resources: [.process("Resources")]
    ),
    // The tray had no tests at all, so every assertion about it lived in
    // test/tray-rebuild.test.mjs as a regex over the source text -- which
    // proves the source says something, not that it does something.
    .testTarget(
      name: "CodexRouterTrayTests",
      dependencies: ["CodexRouterTray"],
      path: "Tests"
    ),
  ],
)
