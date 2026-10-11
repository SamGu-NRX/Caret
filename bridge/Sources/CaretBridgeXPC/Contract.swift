import Foundation

// The XPC contract between caret-bridge and the Caret host (W3, lead decision on bridge auth). The host vends a Mach
// service; the bridge connects. Each side holds the other to a code-signing requirement (Trust.swift), so macOS, not a
// file anyone running as the user could read, decides who is on the other end. The host then relays to the helper's
// page.sock over the handshake the helper already speaks (HostRelay.swift).
//
// Messages on one connection arrive in the order sent, so a revoke the helper sends after a command reaches the
// extension after it, as the memo's ordering rule needs.

/// What the host exports to a bridge.
@objc(CaretBridgeHost) public protocol CaretBridgeHost {
    /// The bridge's first call. `extensionId` is the one Chrome passed the bridge as its origin; `bridgeVersion` its
    /// own. The host checks the bridge's parent is a browser it knows, connects to page.sock and completes the helper's
    /// handshake for it, then replies with the engine session id, or nil and why.
    func open(extensionId: String, bridgeVersion: String, reply: @escaping @Sendable (String?, String?) -> Void)

    /// One message from the extension: a JSON object with no newline. The host passes on only extension-to-helper
    /// types (Relay.admit), whatever the bridge already checked.
    func send(_ line: Data)
}

/// What a bridge exports to the host.
@objc(CaretBridgeClient) public protocol CaretBridgeClient {
    /// One line from the helper, already limited to helper-to-extension types. The bridge frames it for Chrome.
    func receive(_ line: Data)

    /// The host ended the session: the helper went away, or the session was refused after open.
    func closed(_ why: String)
}

public enum BridgeInterfaces {
    public static func host() -> NSXPCInterface { NSXPCInterface(with: CaretBridgeHost.self) }
    public static func client() -> NSXPCInterface { NSXPCInterface(with: CaretBridgeClient.self) }
}
