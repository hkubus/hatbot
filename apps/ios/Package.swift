// swift-tools-version: 6.0
// The app's Foundation-only core as a package, so it builds and tests anywhere Swift runs
// (`swift test`, including on Linux). The app itself is built from project.yml.
import PackageDescription

let package = Package(
  name: "HatbotCore",
  platforms: [.iOS(.v18), .macOS(.v15)],
  targets: [
    .target(name: "HatbotCore", path: "Hatbot/Core"),
    .testTarget(name: "HatbotCoreTests", dependencies: ["HatbotCore"], path: "Tests/HatbotCoreTests"),
  ]
)
