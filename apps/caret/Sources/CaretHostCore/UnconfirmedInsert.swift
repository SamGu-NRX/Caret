import Foundation

/// What Caret may do with a field after an insert it could not confirm: one that was stopped,
/// revoked, faulted, or never read back as predicted. This is the lead's ruling for the helper's
/// writes (S1), extended to the host's own inserts, which replace a range of the field (S2).
///
/// Before writing, Caret records the field's value and the range the insert replaces. A later read
/// of the field is in exactly one of four states:
///
/// - `original`: the value Caret recorded. Nothing landed, so there is nothing to undo.
/// - `whole`: the recorded value with the whole intended text over the recorded range. Ordinary undo.
/// - `partial`: the recorded value with a non-empty proper prefix of the intended text over the
///   recorded range, and every other character unchanged. Those characters are provably Caret's, so
///   ⌘Z restores the recorded value, and the grant records that the write was partial.
/// - `unrecognized`: anything else. Caret does not touch the field; it says what the field holds and
///   what it held before, and leaves it to the user.
///
/// The original wins over a prefix: a field that reads as recorded is `original` even when the
/// replaced text happens to begin the intended text. An empty prefix over a non-empty range (the
/// selection gone, nothing typed) is `unrecognized`, as S1 does not recognize an emptied field: the
/// user's own Delete leaves the same text.
///
/// Offsets and lengths are UTF-16 code units, as Accessibility ranges are.
public enum UnconfirmedInsert {
    public enum State: Equatable, Sendable {
        case original
        case whole
        /// The UTF-16 length of the intended text's prefix that went in: more than 0, less than all.
        case partial(inserted: Int)
        case unrecognized
    }

    /// The insert Caret meant: `before[start..<end]` replaced by `replacement`.
    public struct Intent: Equatable, Sendable {
        public var before: String
        public var start: Int
        public var end: Int
        public var replacement: String

        public init(before: String, start: Int, end: Int, replacement: String) {
            self.before = before
            self.start = start
            self.end = end
            self.replacement = replacement
        }
    }

    public static func classify(_ intent: Intent, held: String) -> State {
        let before = Array(intent.before.utf16)
        let now = Array(held.utf16)
        if now == before { return .original }
        guard intent.start >= 0, intent.start <= intent.end, intent.end <= before.count else { return .unrecognized }
        let head = before[..<intent.start]
        let tail = before[intent.end...]
        guard now.count >= head.count + tail.count, now.starts(with: head), now.suffix(tail.count).elementsEqual(tail) else {
            return .unrecognized
        }
        let middle = now[head.count ..< now.count - tail.count]
        let text = Array(intent.replacement.utf16)
        if middle.elementsEqual(text) { return .whole }
        if !middle.isEmpty, middle.count < text.count, text.starts(with: middle) { return .partial(inserted: middle.count) }
        return .unrecognized
    }

    /// The read Caret made of the field after an unconfirmed write, and what it found.
    public struct Report: Equatable, Sendable {
        public var state: State
        /// The field's value at that read; nil when it could not be read, or another element answered.
        public var held: String?
        /// The value Caret recorded before the write.
        public var before: String

        public init(state: State, held: String?, before: String) {
            self.state = state
            self.held = held
            self.before = before
        }

        /// The state's name for the debug socket and counters. It carries no field text.
        public var name: String {
            switch state {
            case .original: return "original"
            case .whole: return "whole"
            case .partial: return "partial"
            case .unrecognized: return held == nil ? "unreadable" : "unrecognized"
            }
        }

        /// S1's words for a field Caret leaves to the user; nil for the three states it recognizes.
        public var says: String? {
            guard state == .unrecognized else { return nil }
            guard let held else { return "Caret could not read the field after writing it; before the write it held \(quoted(before))" }
            return "\(contents(before: before, held: held)); Caret left it as it is"
        }
    }

    /// Classifies one read; `held` nil (unreadable) is `unrecognized`.
    public static func read(_ intent: Intent, held: String?) -> Report {
        Report(state: held.map { classify(intent, held: $0) } ?? .unrecognized, held: held, before: intent.before)
    }

    /// The grant a write leaves, from the one armed before it and what became of the write.
    ///
    /// A verified write, or one whose later read held the whole text, keeps ordinary undo: ⌘Z then
    /// needs the field to hold exactly that, so a field the user shortened afterwards is never taken
    /// for a partial write (S1 review). A partial read leaves an unconfirmed grant, which ⌘Z judges
    /// against the field as it reads then: posted keys may still have landed after this read.
    /// Nothing to undo, or a field Caret does not recognize, leaves no grant.
    public static func grant(armed: UndoGrant, verified: Bool, report: Report?) -> UndoGrant? {
        var grant = armed
        grant.unconfirmed = false
        grant.partialWrite = false
        if verified { return grant }
        switch report?.state {
        case .whole?:
            return grant
        case .partial?:
            grant.unconfirmed = true
            grant.partialWrite = true
            return grant
        case .original?, .unrecognized?, nil:
            return nil
        }
    }

    /// S1's wording: JSON quoting keeps empty text, newlines and quotes distinguishable.
    public static func contents(before: String, held: String) -> String {
        "the field now holds \(quoted(held)); before the write it held \(quoted(before))"
    }

    /// `text` as JavaScript's `JSON.stringify` writes it, so the host and the helper quote alike.
    public static func quoted(_ text: String) -> String {
        var out = "\""
        for unit in text.unicodeScalars {
            switch unit {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case let c where c.value < 0x20: out += String(format: "\\u%04x", c.value)
            default: out.unicodeScalars.append(unit)
            }
        }
        return out + "\""
    }
}
