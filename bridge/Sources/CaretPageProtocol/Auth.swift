import CryptoKit
import Foundation
import Security

/// The connecting side of the page.sock handshake (helper/src/engines/auth.ts has the other). Since W3 that side is the
/// Caret host, relaying for a bridge it verified over XPC (CaretBridgeXPC); the bridge itself never reaches page.sock.
/// The key is the launch's page key, HMAC-SHA256(launch secret, "caret-page-key") (`pageKey`), held in memory by both
/// the helper and the host, never written to a file. Neither side sends it; each proves it holds it with HMAC-SHA256
/// over both nonces under its own label, and the helper's proof also names its pid, which the connecting side requires
/// to be its socket's peer (Peer.pid), so a relay to the real helper is refused.
public enum Handshake {
    /// The launch's page key, derived from the 32-byte launch secret, as the helper derives it (auth.ts pageKey).
    public static func pageKey(launchSecret: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data("caret-page-key".utf8), using: SymmetricKey(data: launchSecret)))
    }

    /// Bound to the pid of the helper this side sees as its socket's peer, so a hello passed through by a process that
    /// took over the socket path does not authenticate that process's own connection to the real helper (W3 review #1).
    public static func bridgeProof(secret: Data, challenge: String, nonce: String, helperPid: Int) -> String {
        hmac(secret, "caret-page-bridge\n\(challenge)\n\(nonce)\n\(helperPid)")
    }

    public static func helperProof(secret: Data, challenge: String, nonce: String, pid: Int) -> String {
        hmac(secret, "caret-page-helper\n\(nonce)\n\(challenge)\n\(pid)")
    }

    /// Compares two hex proofs in time independent of where they differ.
    public static func matches(_ a: String, _ b: String) -> Bool {
        guard let x = Data(hex: a), let y = Data(hex: b), x.count == 32, y.count == 32 else { return false }
        var diff: UInt8 = 0
        for i in 0..<32 { diff |= x[i] ^ y[i] }
        return diff == 0
    }

    /// 32 random bytes as hex.
    public static func nonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        return Data(bytes).hex
    }

    private static func hmac(_ secret: Data, _ message: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: secret))).hex
    }
}

extension Data {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }

    public init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var it = hex.utf8.makeIterator()
        while let h = it.next(), let l = it.next() {
            guard let hi = Self.nibble(h), let lo = Self.nibble(l) else { return nil }
            out.append(hi << 4 | lo)
        }
        self = out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 48...57: c - 48
        case 97...102: c - 87
        default: nil
        }
    }
}
