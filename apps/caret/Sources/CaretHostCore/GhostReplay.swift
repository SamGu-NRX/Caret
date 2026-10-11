import Foundation

/// Ghost text outcomes recorded with the model on one Mac, replayed by context on another that has
/// no model (`Caret --ghost-replay <file>`, test hooks only). The rig's VM has 4 GB of memory and
/// Cotypist's 3.4 GB model does not fit in it, so A18's on-screen run types fixed sentences with
/// real keys in the guest and draws what the model chose for each on the host (`Caret --probe`).
///
/// File: `{"entries": [{"before": "...", "after": "...", "text": "..." or null, "reason": "..."}]}`.
public struct GhostReplay: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var before: String
        public var after: String
        /// The completion offered; nil when the engine stayed silent, and `reason` says why.
        public var text: String?
        public var reason: String?

        public init(before: String, after: String, text: String?, reason: String? = nil) {
            self.before = before
            self.after = after
            self.text = text
            self.reason = reason
        }
    }

    public enum Outcome: Equatable, Sendable {
        case text(String)
        case silent(String)
    }

    public var entries: [Entry]

    public init(entries: [Entry]) { self.entries = entries }

    /// The recorded outcome for a context: the text before the caret ends with the entry's, and
    /// the text after it, ignoring trailing whitespace, is the entry's. A field holds more text
    /// before the caret than the sentence the run typed (earlier lines), never less.
    public func outcome(before: String, after: String) -> Outcome? {
        let tail = Self.trimmedEnd(after)
        guard let entry = entries.first(where: { before.hasSuffix($0.before) && Self.trimmedEnd($0.after) == tail }) else { return nil }
        if let text = entry.text { return .text(text) }
        return .silent(entry.reason ?? "replaySilent")
    }

    static func trimmedEnd(_ s: String) -> String {
        String(s.reversed().drop { $0.isWhitespace }.reversed())
    }
}
