// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CaretBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "caret-bridge", targets: ["caret-bridge"]),
        .executable(name: "caret-bridge-testhost", targets: ["caret-bridge-testhost"]),
        .library(name: "CaretPageProtocol", targets: ["CaretPageProtocol"]),
        .library(name: "CaretBridgeXPC", targets: ["CaretBridgeXPC"]),
    ],
    targets: [
        // The page wire's Swift mirror, Native Messaging framing, page.sock's handshake proofs, and the peer checks. No run loop.
        .target(name: "CaretPageProtocol"),
        // The XPC contract between the bridge and the Caret host, the code-signing requirements each side holds the
        // other to, the bridge's client, and the host's relay to page.sock. Caret.app (apps/caret) links it by path.
        .target(name: "CaretBridgeXPC", dependencies: ["CaretPageProtocol"]),
        // The Native Messaging host Chrome launches: Native Messaging frames to and from the Caret host, over XPC.
        .executableTarget(name: "caret-bridge", dependencies: ["CaretPageProtocol", "CaretBridgeXPC"]),
        // A stand-in for Caret.app's side, for tests and the acceptance run: it vends the XPC service under launchd
        // and relays to a helper's page.sock with a launch secret it is handed. Not shipped.
        .executableTarget(name: "caret-bridge-testhost", dependencies: ["CaretPageProtocol", "CaretBridgeXPC"]),
        .testTarget(name: "CaretPageProtocolTests", dependencies: ["CaretPageProtocol", "CaretBridgeXPC"]),
    ]
)
