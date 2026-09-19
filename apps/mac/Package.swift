// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Caret",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Caret", targets: ["Caret"])],
    targets: [
        // Transport to the Python core plus focused-field capture. Separate
        // from the app target so the protocol logic is testable without a
        // running AppKit application.
        .target(
            name: "CaretCore",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
            ]
        ),
        .executableTarget(
            name: "Caret",
            dependencies: ["CaretCore"],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .testTarget(
            name: "CaretCoreTests",
            dependencies: ["CaretCore"],
            path: "Tests/CaretCoreTests"
        ),
    ]
)
