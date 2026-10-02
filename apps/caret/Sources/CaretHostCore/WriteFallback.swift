import Foundation

/// The rules for writing into another app's field after the guard approved the edit, kept apart
/// from the AX and event calls so each case can be tested on its own.
///
/// A pid-posted ⌘V is tried first. If the field is still exactly as it was after
/// `ignoredAfter`, the app is taken to ignore pid-posted paste and the value is written through
/// `AXSelectedText` instead. Any other outcome (partial text, other text, another element) is a
/// failure and is never retried, because a second write could double the value.
public enum WriteFallback {
    public enum Settle: Equatable, Sendable {
        case matched
        /// Still exactly the pre-write value.
        case unchanged
        case different
    }

    public enum Step: Equatable, Sendable {
        case verified
        case fallBackToAX
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

    /// What to do after the pid paste settled.
    public static func afterPaste(_ settle: Settle, usedPasteboard: Bool, postError: String?) -> Step {
        if let postError { return .failed(postError) }
        switch settle {
        case .matched: return .verified
        // Character injection posts the text itself; an app that ignored it would ignore the AX
        // route's premise too, so only a pasteboard paste falls back.
        case .unchanged: return usedPasteboard ? .fallBackToAX : .failed("writeIgnored")
        case .different: return .failed("writeMismatch")
        }
    }

    /// What the field holds if a paste the app had already taken lands after the AX fallback
    /// wrote the same text: the insertion twice at the caret. Only this exact value is repaired;
    /// anything else may be the user typing and is left alone. Nil for an invalid span.
    public static func lateDuplicate(original: String, start: Int, end: Int, replacement: String) -> String? {
        let total = UTF16Text.length(original)
        guard let prefix = UTF16Text.slice(original, start: 0, end: start),
              let suffix = UTF16Text.slice(original, start: end, end: total)
        else { return nil }
        return prefix + replacement + replacement + suffix
    }

    /// What to do after the AX write settled.
    public static func afterAX(_ settle: Settle) -> Step {
        switch settle {
        case .matched: return .verified
        case .unchanged: return .failed("writeIgnored")
        case .different: return .failed("writeMismatch")
        }
    }
}
