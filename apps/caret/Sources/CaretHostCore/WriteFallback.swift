import Foundation

/// The rules for writing into another app's field after the guard approved the edit, kept apart
/// from the AX and event calls so each case can be tested on its own.
///
/// An `AXSelectedText` replacement on the approved element is tried first (A17): it can only land
/// in that element, and it leaves the general pasteboard alone. If the app refuses it with an AX
/// error, a pid-posted ⌘V through the reconciled pasteboard is tried instead, and the app is
/// remembered. An AX write the app took and did not show is a failure, not a reason to paste: it may
/// still land, and a second write could double the value. Any other outcome (partial text, other
/// text, another element) is a failure and is never retried.
///
/// A pid-posted paste goes to whichever element of the app has focus when the app handles it, which
/// may no longer be the one checked before the post (S1 audit #13). The after-read finds such a
/// paste in the element that now has focus (`strayInsertion`), and the failure names that field.
public enum WriteFallback {
    public enum Settle: Equatable, Sendable {
        case matched
        /// Still exactly the pre-write value.
        case unchanged
        case different
    }

    public enum Step: Equatable, Sendable {
        case verified
        /// The app refused the AX write: paste instead.
        case fallBackToPaste
        case failed(String)
    }

    /// One reread of the field while waiting for a write to land. Nil means keep polling.
    public static func classify(
        value: String?, sameElement: Bool, expected: String, unchanged: String,
        elapsed: TimeInterval, ignoredAfter: TimeInterval, timeout: TimeInterval
    ) -> Settle? {
        if let value, value == expected { return sameElement ? .matched : .different }
        // Another element's value says nothing about the approved one. Read as `unchanged`, it made
        // `writeIgnored`, which moves the app to the paste route for good (CodeRabbit on PR #8).
        if value != nil, !sameElement { return .different }
        if let value, value == unchanged, elapsed >= ignoredAfter { return .unchanged }
        if elapsed >= timeout { return value == unchanged ? .unchanged : .different }
        return nil
    }

    /// What to do after the AX write. `refused` is an AX error from the selection or text write.
    public static func afterAX(_ settle: Settle?, refused: Bool) -> Step {
        if refused { return .fallBackToPaste }
        switch settle {
        case .matched?: return .verified
        case .unchanged?: return .failed("writeIgnored")
        case .different?, nil: return .failed("writeMismatch")
        }
    }

    public enum Route: Equatable, Sendable {
        case axWrite, paste
    }

    /// Whether a write should paste rather than try `AXSelectedText` first. `learned`: what this app
    /// was found to need (true: a paste), nil until a write there has told. `selectedTextSettable`:
    /// the field's own answer for `AXSelectedText`, nil when it gave none. `electron`: an Electron
    /// app (`AppFamily.electron`).
    ///
    /// The VM runs on v2/inline (20261009T103304Z-38308, 20261009T104144Z-36771) found two kinds
    /// of field that answer an `AXSelectedText` write with success and never change, so their first
    /// Tab used to insert nothing (`writeIgnored`) and only later ones pasted:
    /// - Mac Catalyst text views and fields, which also say the attribute is not settable;
    /// - Electron 44's textarea and contenteditable, a value unchanged 1.5 s after the write.
    /// A field that says it cannot take the write is believed; Electron is known by its framework.
    public static func pastesFirst(learned: Bool?, selectedTextSettable: Bool?, electron: Bool) -> Bool {
        if let learned { return learned }
        return selectedTextSettable == false || electron
    }

    /// The failure code when the paste route was the only one left and the clipboard holds
    /// something Caret cannot restore exactly (`ReconcilingClipboard.unrestorable`).
    public static let clipboardUnrestorable = "clipboardUnrestorable"

    /// The first write for a claim. An app known to need a paste (`appPastes`) is pasted into,
    /// unless the clipboard holds something Caret cannot restore exactly: then this insert tries
    /// the AX write instead (lead decision, 2026-10-04: no paste beats a partial restore).
    public static func firstRoute(appPastes: Bool, clipboardRestorable: Bool) -> Route {
        appPastes && clipboardRestorable ? .paste : .axWrite
    }

    /// The app refused the AX write with an error: paste, or, when the clipboard cannot be
    /// restored exactly, fail so the claim hands off rather than paste.
    public static func afterAXRefused(clipboardRestorable: Bool) -> Step {
        clipboardRestorable ? .fallBackToPaste : .failed(clipboardUnrestorable)
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
