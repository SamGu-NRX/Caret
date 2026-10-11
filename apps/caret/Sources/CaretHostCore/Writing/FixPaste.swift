import Foundation

/// A writing fix in an app that pastes ghost text (`WriteFallback.pastesFirst`): the word is
/// selected through Accessibility, then replaced by a paste. Lead decision of 2026-10-09: this
/// replaces D2-09's "range edits only through Accessibility" for those apps, because Electron and
/// Mac Catalyst fields take a range edit's `AXSelectedText` write and change nothing (VM runs on
/// v2/inline, 20261009T104144Z-36771), so fixes there could never apply.
///
/// The executor runs the steps; this type holds the rules each step answers to.
/// 1. Select exactly the word, then read the selection back until it is that range, for at most
///    `selectionTimeout`. A selection that never takes ends the fix with no paste, and the app gets
///    no more fixes this session.
/// 2. Validate the field as `RangeEdit` does (same element, same whole value as when offered, not
///    secure, the range selected).
/// 3. Paste through the clipboard Caret pastes ghost text with.
/// 4. Read the value back (`afterPaste`). Anything but the predicted value in the same field is
///    taken back with one ⌘Z, and the value must then be exactly the one before (`afterUndo`).
public enum FixPaste {
    /// How long a selection set may take to read back. Chosen, not measured: Electron 44 showed
    /// the new range at the first 20 ms read and Catalyst at once (the same VM runs).
    public static let selectionTimeout: TimeInterval = 0.15

    /// What the field holds after the paste settled.
    public enum AfterPaste: Equatable, Sendable {
        /// The value before, with exactly the range replaced.
        case applied
        /// The value before, untouched: the paste did not land, and nothing needs taking back.
        case untouched
        /// Anything else, or an unreadable field: one ⌘Z, then `afterUndo`.
        case mismatch
    }

    public static func afterPaste(value: String?, before: String, expected: String) -> AfterPaste {
        guard let value else { return .mismatch }
        if value.utf16.elementsEqual(expected.utf16) { return .applied }
        if value.utf16.elementsEqual(before.utf16) { return .untouched }
        return .mismatch
    }

    /// The executor's failure codes, which `WritingCopy.notFixed` turns into the line the user sees.
    public enum Failure: String, Sendable {
        /// The selection never became the word's range; nothing was pasted.
        case selectionNotTaken
        /// The paste left something else; one ⌘Z put the value back exactly.
        case fixUndone
        /// The paste left something else, and the value could not be shown to be back.
        case fixNotRestored
    }

    /// After the one ⌘Z: the value must be exactly the value before the fix.
    public static func afterUndo(value: String?, before: String) -> Failure {
        value?.utf16.elementsEqual(before.utf16) == true ? .fixUndone : .fixNotRestored
    }

    /// Whether the app keeps getting fixes this session after a failure with this code.
    public static func keepsFixes(after code: String) -> Bool {
        code != Failure.selectionNotTaken.rawValue && code != Failure.fixNotRestored.rawValue
    }
}

/// Keys the user types into an app while Caret writes a fix there are held and replayed after it,
/// in order. Typed while the word is selected for the fix, a key would replace the word.
///
/// Generic over the event so the rules are tested without the window server. One hold at a time;
/// a hold past its deadline lets everything go, so a stuck write can't swallow typing.
public struct KeyHoldQueue<Event> {
    public private(set) var pid: Int32?
    public private(set) var deadline: UInt64 = 0
    public private(set) var held: [Event] = []

    /// Longest hold. Chosen, not measured: the selection wait, the paste's settle time (1.5 s) and
    /// the ⌘Z's (1.5 s), with room to spare.
    public static var maxHoldNanos: UInt64 { 3_500_000_000 }

    public init() {}

    /// Starts holding keys for `pid`. Returns what an earlier hold still held, to send first.
    public mutating func begin(pid: Int32, now: UInt64) -> [Event] {
        let earlier = held
        self.pid = pid
        deadline = now &+ Self.maxHoldNanos
        held = []
        return earlier
    }

    public enum Take {
        /// Keep it; it goes out at `end`.
        case hold
        /// Let it through now. `first` are held keys to send before it (an expired hold).
        case pass(first: [Event])
    }

    public mutating func take(_ event: Event, pid target: Int32?, now: UInt64) -> Take {
        guard let pid else { return .pass(first: []) }
        if now > deadline { return .pass(first: end()) }
        guard target == pid else { return .pass(first: []) }
        held.append(event)
        return .hold
    }

    /// Stops holding. Returns the held keys, oldest first.
    public mutating func end() -> [Event] {
        let out = held
        pid = nil
        held = []
        return out
    }
}
