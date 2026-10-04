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
        // EventKit behind CalendarAdapter (B16). Never asks for Calendar access.
        .target(name: "CaretScreenCalendar", dependencies: ["CaretScreenCore"], linkerSettings: [.linkedFramework("EventKit")]),
        .executableTarget(name: "caret-screen", dependencies: ["CaretScreenAX", "CaretScreenCore", "CaretScreenCalendar"]),
        // Synthetic AppKit windows for tests and experiments. Shows invented data only.
        // Swift 5 mode: Timer callbacks that invalidate themselves are not worth Swift 6's ceremony in a test fixture.
        .executableTarget(name: "caret-fixture", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "CaretScreenCoreTests", dependencies: ["CaretScreenCore"]),
        // The socket client against a socket the test plays the helper on (B22). No Accessibility call is made.
        .testTarget(name: "CaretScreenAXTests", dependencies: ["CaretScreenAX", "CaretScreenCore"]),
    ]
)
