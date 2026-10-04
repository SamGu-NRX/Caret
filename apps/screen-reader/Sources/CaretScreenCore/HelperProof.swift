// The helper's proof that it holds the launch secret (B23, CodeRabbit on PR #4). Before B23 the reader trusted any
// process listening at the socket path, so a process of the same user that took the path got every snapshot and
// could send act grants and commands, borrowing Caret's Accessibility grant. Now the launcher hands the reader and
// the helper one 32-byte secret on an inherited descriptor; the reader's hello carries a fresh challenge, and the
// helper must answer with HMAC-SHA256(secret, "caret-helper-proof\n" + challenge) before the reader sends or acts on
// anything. server.ts helperProof makes the same answer.
import CryptoKit
import Foundation

public enum HelperProof {
    /// Bytes in a launch secret and in a challenge.
    public static let bytes = 32

    /// A fresh challenge: base64 of 32 random bytes.
    public static func challenge() -> String {
        var g = SystemRandomNumberGenerator()
        return Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max, using: &g) }).base64EncodedString()
    }

    /// A reader launch id: 16 random bytes in hex, the same for every connection of one reader process.
    public static func launchId() -> String {
        var g = SystemRandomNumberGenerator()
        return "reader-" + (0..<16).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &g)) }.joined()
    }

    private static func message(_ challenge: String) -> Data { Data("caret-helper-proof\n\(challenge)".utf8) }

    /// The proof a helper holding `secret` sends for `challenge`.
    public static func proof(secret: Data, challenge: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: message(challenge), using: SymmetricKey(data: secret))).base64EncodedString()
    }

    /// Whether `proof` is the answer to `challenge` under `secret`, compared in constant time.
    public static func verify(_ proof: String, secret: Data, challenge: String) -> Bool {
        guard let mac = Data(base64Encoded: proof) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: message(challenge), using: SymmetricKey(data: secret))
    }
}
