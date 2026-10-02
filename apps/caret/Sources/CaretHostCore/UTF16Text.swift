import CryptoKit
import Foundation

/// Text helpers in UTF-16 code units, the unit Accessibility uses for `AXSelectedTextRange`.
///
/// Ported from the team repo's `apps/mac/Sources/CaretCore/NearbyTextWindow.swift` so the host's
/// offsets and digests match what the Python core and the old app produce.
public enum UTF16Text {
    public static func length(_ text: String) -> Int { text.utf16.count }

    /// Slice by UTF-16 code units. Returns nil for an out-of-range or surrogate-splitting range.
    public static func slice(_ text: String, start: Int, end: Int) -> String? {
        guard start >= 0, end >= start, end <= text.utf16.count else { return nil }
        let view = text.utf16
        guard let from = view.index(view.startIndex, offsetBy: start, limitedBy: view.endIndex),
              let to = view.index(view.startIndex, offsetBy: end, limitedBy: view.endIndex)
        else { return nil }
        // A String initializer from a UTF16View slice fails when either bound lands inside a
        // surrogate pair.
        return String(view[from..<to])
    }

    /// The core's content digest: first 16 hex characters of SHA-256 over UTF-8. Logs and the
    /// debug socket carry this, never the text it covers.
    public static func digest(_ text: String) -> String {
        let hash = SHA256.hash(data: Data(text.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}
