// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Caret",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Caret", targets: ["Caret"])],
    targets: [
        .executableTarget(
            name: "Caret",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .testTarget(
            name: "CaretTests",
            dependencies: ["Caret"],
            path: "Tests"
        ),
    ]
)
