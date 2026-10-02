// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CaretScreen",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "caret-screen", targets: ["caret-screen"]),
        .executable(name: "caret-fixture", targets: ["caret-fixture"]),
        .library(name: "CaretScreenCore", targets: ["CaretScreenCore"]),
    ],
    targets: [
        // Pure logic with no Accessibility calls: wire types, element keys, compaction, typed values.
        .target(name: "CaretScreenCore"),
        // Every Accessibility read: walks, observers, per-app queues, the socket client.
        .target(name: "CaretScreenAX", dependencies: ["CaretScreenCore"]),
        .executableTarget(name: "caret-screen", dependencies: ["CaretScreenAX", "CaretScreenCore"]),
        // Synthetic AppKit windows for tests and experiments. Shows invented data only.
        .executableTarget(name: "caret-fixture"),
        .testTarget(name: "CaretScreenCoreTests", dependencies: ["CaretScreenCore"]),
    ]
)
