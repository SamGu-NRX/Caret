import Foundation

/// The rules for writing into another app's field after the guard approved the edit, kept apart
/// from the AX and event calls so each case can be tested on its own.
///
/// An `AXSelectedText` replacement on the approved element is tried first (A17): it can only land
/// in that element, and it leaves the general pasteboard alone. If the app refuses it, or accepts it
/// and leaves the field exactly as it was after `ignoredAfter`, a pid-posted ⌘V through the
/// reconciled pasteboard is tried instead, and the app is remembered. Any other outcome (partial
/// text, other text, another element) is a failure and is never retried, because a second write
/// could double the value.
///
/// A pid-posted paste goes to whichever element of the app has focus when the app handles it, which
/// may no longer be the one checked before the post (S1 audit #13). The after-read finds such a
/// paste in the element that now has focus (`strayInsertion`), and the executor removes it there or
/// reports a failure that names that field.
public enum WriteFallback {
    public enum Settle: Equatable, Sendable {
        case matched
        /// Still exactly the pre-write value.
        case unchanged
        case different
    }

    public enum Step: Equatable, Sendable {
        case verified
        /// The app ignored the AX write: paste instead.
        case fallBackToPaste
        case failed(String)
    }

    /// One reread of the field while waiting for a write to land. Nil means keep polling.
    public static func classify(
        value: String?, sameElement: Bool, expected: String, unchanged: String,
        elapsed: TimeInterval, ignoredAfter: TimeInterval, timeout: TimeInterval
    ) -> Settle? {
        if let value, value == expected { return sameElement ? .matched : .different }
        if let value, value == unchanged, elapsed >= ignoredAfter { return .unchanged }
        if elapsed >= timeout { return value == unchanged ? .unchanged : .different }
        return nil
    }

    /// What to do after the AX write. `refused` is an AX error from the selection or text write.
    public static func afterAX(_ settle: Settle?, refused: Bool) -> Step {
        if refused { return .fallBackToPaste }
        switch settle {
        case .matched?: return .verified
        case .unchanged?: return .fallBackToPaste
        case .different?, nil: return .failed("writeMismatch")
        }
    }

    /// What to do after the pid paste settled. There is no fallback after it: the AX route was tried
    /// first, or the app is known to refuse it.
    public static func afterPaste(_ settle: Settle, postError: String?) -> Step {
        if let postError { return .failed(postError) }
        switch settle {
        case .matched: return .verified
        case .unchanged: return .failed("writeIgnored")
        case .different: return .failed("writeMismatch")
        }
    }

    /// What the field holds if an AX write the app accepted silently lands after the paste that
    /// replaced it: the insertion twice at the caret. Only this exact value is repaired; anything
    /// else may be the user typing and is left alone. Nil for an invalid span.
    public static func lateDuplicate(original: String, start: Int, end: Int, replacement: String) -> String? {
        let total = UTF16Text.length(original)
        guard let prefix = UTF16Text.slice(original, start: 0, end: start),
              let suffix = UTF16Text.slice(original, start: end, end: total)
        else { return nil }
        return prefix + replacement + replacement + suffix
    }

    /// The span of a stray paste in the element that has focus after the write, when the write did
    /// not land in the approved element: the inserted text ends exactly at that element's caret.
    /// Nil when focus is still on the approved element, the element is unreadable, or the text
    /// before its caret is anything else (the user's own typing is never touched).
    public static func strayInsertion(focusIsApproved: Bool, value: String?, caret: Int?, inserted: String) -> (start: Int, length: Int)? {
        guard !focusIsApproved, let value, let caret, !inserted.isEmpty else { return nil }
        let length = UTF16Text.length(inserted)
        let start = caret - length
        guard start >= 0, let before = UTF16Text.slice(value, start: start, end: caret), before == inserted else { return nil }
        return (start, length)
    }
}
