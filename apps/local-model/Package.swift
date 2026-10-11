// swift-tools-version: 6.0
import PackageDescription

// caret-local-model (G1): loads one GGUF by path and answers grammar-constrained completions over stdin and
// stdout, one JSON object per line. The helper's local intent maker drives it (helper/src/writer/local-model.ts).
let package = Package(
    name: "CaretLocalModel",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "caret-local-model", targets: ["caret-local-model"]),
    ],
    targets: [
        // Request framing, the wire types and memory readings: no llama call, so its tests need no model.
        .target(name: "LocalModelCore"),
        // KeyType's llama.cpp build, copied from packages/keytype/Packages/ModelRuntime/Vendor and gitignored
        // here (see README.md for the copy command).
        .binaryTarget(name: "llama", path: "Vendor/llama.xcframework"),
        .target(name: "LocalModelLlama", dependencies: ["llama", "LocalModelCore"]),
        .executableTarget(name: "caret-local-model", dependencies: ["LocalModelCore", "LocalModelLlama"]),
        .testTarget(name: "LocalModelCoreTests", dependencies: ["LocalModelCore"]),
        // Loads only the model's vocabulary (vocab_only), never its weights.
        .testTarget(name: "LocalModelLlamaTests", dependencies: ["LocalModelLlama", "llama"], resources: [.copy("Fixtures")]),
    ]
)
