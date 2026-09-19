import ApplicationServices
import AppKit
import CaretCore

/// Applying an accepted edit to the live field.
///
/// Everything this file used to do besides writing -- focused-field capture,
/// element and window identity, bounded windowing, digesting and validation --
/// now belongs to `CaretCore` (`FocusedTargetCapture`, `AXIdentityRegistry`,
/// `NearbyTextWindow`, `InsertionGuard`). Those were deleted rather than kept
/// in parallel: a second identity scheme mints different tokens and would make
/// every acceptance fail, and a second slicer risked splitting a surrogate
/// pair where the core's does not.
///
/// What stays here is the one thing the core does not own: the native AX write
/// and its read-back.
enum InlineFieldAccess {

    enum InsertFailure: Error, Equatable {
        case noLiveField
        case rejected(String)
        case couldNotSetSelection
        case couldNotSetText
        case verificationFailed
    }

    /// Applies an approved edit through the field's own editing path.
    ///
    /// Setting `kAXSelectedText` replaces the selection the way a keystroke
    /// would, so the host app registers its own undo group and Cmd-Z restores
    /// the field. Setting `kAXValue` for the whole field is deliberately not
    /// done: it replaces the field wholesale, loses the app's undo
    /// granularity, and would make a claim of native undo false. The clipboard
    /// is never touched.
    ///
    /// `element` must be the element the approved target was captured from.
    @discardableResult
    static func apply(_ edit: InsertionGuard.ApprovedEdit, to element: AXUIElement) -> Result<String, InsertFailure> {
        var range = CFRange(location: edit.replaceStart, length: edit.replaceEnd - edit.replaceStart)
        guard let rangeValue = AXValueCreate(.cfRange, &range) else {
            return .failure(.couldNotSetSelection)
        }
        guard AXUIElementSetAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, rangeValue
        ) == .success else { return .failure(.couldNotSetSelection) }

        guard AXUIElementSetAttributeValue(
            element, kAXSelectedTextAttribute as CFString, edit.replacement as CFTypeRef
        ) == .success else { return .failure(.couldNotSetText) }

        // An AX call can report success and change nothing, so the result is
        // read back rather than assumed.
        guard let after = AXHelpers.stringValue(element, kAXValueAttribute as CFString) else {
            return .failure(.verificationFailed)
        }
        guard after == edit.resultingValue else { return .failure(.verificationFailed) }
        return .success(after)
    }

    /// The text a field should hold after an edit. Pure, so the expected
    /// result is computed the same way in tests and at runtime. Uses
    /// `UTF16Text.slice`, which refuses to split a surrogate pair.
    static func applying(offer: InlineOffer, to text: String) -> String {
        let total = UTF16Text.length(text)
        guard offer.replaceStart >= 0,
              offer.replaceEnd >= offer.replaceStart,
              offer.replaceEnd <= total,
              let head = UTF16Text.slice(text, start: 0, end: offer.replaceStart),
              let tail = UTF16Text.slice(text, start: offer.replaceEnd, end: total)
        else { return text }
        return head + offer.replacement + tail
    }

    /// Resolves the AX element for a captured target. The write needs an
    /// element reference; the guard works in tokens.
    static func focusedElement(forPID pid: pid_t) -> AXUIElement? {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        return AXHelpers.focusedElement(in: app)
    }
}
