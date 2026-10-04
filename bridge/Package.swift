// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CaretBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "caret-bridge", targets: ["caret-bridge"]),
        .library(name: "CaretPageProtocol", targets: ["CaretPageProtocol"]),
    ],
    targets: [
        // The page wire's Swift mirror, Native Messaging framing, the handshake, and the secret and peer checks. No run loop.
        .target(name: "CaretPageProtocol"),
        // The Native Messaging host Chrome launches: one authenticated pipe between the extension and the helper's page.sock.
        .executableTarget(name: "caret-bridge", dependencies: ["CaretPageProtocol"]),
        .testTarget(name: "CaretPageProtocolTests", dependencies: ["CaretPageProtocol"]),
    ]
)
