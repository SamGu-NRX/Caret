// swift-tools-version: 5.9

import PackageDescription

// Caret v2 host. The text engine is KeyType's, consumed by path from the pinned submodule; nothing
// under packages/ is edited. ModelRuntime's llama.xcframework is gitignored and must be present
// under packages/keytype/Packages/ModelRuntime/Vendor/ (see apps/caret/README.md).
let keytype = "../../packages/keytype/Packages"

let package = Package(
    name: "CaretHost",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Caret", targets: ["Caret"]),
        .library(name: "CaretHostCore", targets: ["CaretHostCore"]),
        .library(name: "CaretHost", targets: ["CaretHost"]),
    ],
    dependencies: [
        .package(path: "\(keytype)/AutocompleteCore"),
        .package(path: "\(keytype)/AppCompatibility"),
        .package(path: "\(keytype)/MacContextCapture"),
        .package(path: "\(keytype)/Prompting"),
        .package(path: "\(keytype)/ModelRuntime"),
        .package(path: "\(keytype)/ConstrainedGeneration"),
        .package(path: "\(keytype)/TokenProfiles"),
        .package(path: "\(keytype)/CompletionUI"),
        .package(path: "\(keytype)/TextInsertion"),
        .package(path: "\(keytype)/ModelManagement"),
        .package(path: "\(keytype)/ProfileBuilder"),
    ],
    targets: [
        // Pure decision logic: offers, the Tab arbiter, the insertion guard, latency stats and the
        // debug-state schema. No AppKit, no AX, no model, so it tests in milliseconds.
        .target(name: "CaretHostCore"),
        // Everything that touches the system or the model: the tap thread, AX focus observation,
        // the KeyType engine adapter, the overlay, insertion and the debug socket.
        .target(
            name: "CaretHost",
            dependencies: [
                "CaretHostCore",
                .product(name: "AutocompleteCore", package: "AutocompleteCore"),
                .product(name: "AppCompatibility", package: "AppCompatibility"),
                .product(name: "MacContextCapture", package: "MacContextCapture"),
                .product(name: "Prompting", package: "Prompting"),
                .product(name: "ModelRuntime", package: "ModelRuntime"),
                .product(name: "LlamaModelRuntime", package: "ModelRuntime"),
                .product(name: "ConstrainedGeneration", package: "ConstrainedGeneration"),
                .product(name: "TokenProfiles", package: "TokenProfiles"),
                .product(name: "CompletionUI", package: "CompletionUI"),
                .product(name: "TextInsertion", package: "TextInsertion"),
                .product(name: "ModelManagement", package: "ModelManagement"),
                .product(name: "ProfileBuilderCore", package: "ProfileBuilder"),
            ],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
            ]
        ),
        .executableTarget(
            name: "Caret",
            dependencies: ["CaretHost", "CaretHostCore"],
            linkerSettings: [
                // The .app bundle copies llama.framework into Contents/Frameworks.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
        .testTarget(name: "CaretHostCoreTests", dependencies: ["CaretHostCore"]),
        .testTarget(name: "CaretHostTests", dependencies: ["CaretHost", "CaretHostCore"]),
    ]
)
