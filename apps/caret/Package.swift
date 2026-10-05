// swift-tools-version: 5.9

import PackageDescription

// Caret v2 host. The text engine is KeyType's, consumed by path from the pinned submodule; nothing
// under packages/ is edited. ModelRuntime's llama.xcframework is gitignored and must be present
// under packages/keytype/Packages/ModelRuntime/Vendor/ (see apps/caret/README.md).
let keytype = "../../packages/keytype/Packages"
// The screen track's Swift mirror of helper/src/protocol.ts, used by path and not edited, so the
// host decodes helper messages with the same types the reader encodes them with.
let screenReader = "../screen-reader"
// The page bridge's XPC contract and the host's relay to page.sock (W3), used by path and not edited: the host vends
// the service caret-bridge connects to (CaretHost/Services/PageBridgeVendor.swift).
let bridge = "../../bridge"

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
        .package(path: screenReader),
        .package(path: bridge),
    ],
    targets: [
        // Pure decision logic: offers, the Tab arbiter, the insertion guard, latency stats and the
        // debug-state schema, and the fill offers built from helper proposals. No AppKit, no AX, no
        // model, so it tests in milliseconds.
        .target(
            name: "CaretHostCore",
            dependencies: [.product(name: "CaretScreenCore", package: "screen-reader")]
        ),
        // Everything that touches the system or the model: the tap thread, AX focus observation,
        // the KeyType engine adapter, the overlay, insertion and the debug socket.
        .target(
            name: "CaretHost",
            dependencies: [
                "CaretHostCore",
                .product(name: "CaretScreenCore", package: "screen-reader"),
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
                .product(name: "CaretBridgeXPC", package: "bridge"),
                .product(name: "CaretPageProtocol", package: "bridge"),
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
        .testTarget(
            name: "CaretHostCoreTests",
            dependencies: ["CaretHostCore", .product(name: "CaretScreenCore", package: "screen-reader")],
            // Read by #filePath, so a test can name the golden file the helper's schema also uses.
            exclude: ["Fixtures"]
        ),
        .testTarget(
            name: "CaretHostTests",
            dependencies: ["CaretHost", "CaretHostCore", .product(name: "CaretScreenCore", package: "screen-reader")],
            // Reference images, read and rewritten by #filePath (SnapshotTests).
            exclude: ["References"]
        ),
    ]
)
