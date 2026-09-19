import ApplicationServices
import AppKit
import CryptoKit

/// One live reading of the focused editable field.
struct InlineFieldReading {
    var element: AXUIElement
    var target: InlineTarget
    /// The field's full value in UTF-16 units.
    var text: String
    var selection: NSRange
    var role: String
    var secure: Bool
}

/// Reads the focused field through AX, and applies an accepted edit to it.
///
/// Reading and writing live together because the write is only safe in terms
/// of a read taken microseconds earlier: every insertion revalidates against a
/// fresh reading rather than against anything cached from when the offer was
/// made.
enum InlineFieldAccess {

    // MARK: - Reading

    /// Roles Caret will complete in. A role outside this set is not a text
    /// field as far as this feature is concerned, whatever it describes itself
    /// as, because inserting into a guessed role risks editing the wrong thing.
    static let editableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    ]

    static func readFocusedField() -> InlineFieldReading? {
        guard AXHelpers.isTrusted() else { return nil }
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let element = AXHelpers.focusedElement(in: app)
        else { return nil }

        let role = AXHelpers.stringValue(element, kAXRoleAttribute as CFString) ?? ""
        let subrole = AXHelpers.stringValue(element, kAXSubroleAttribute as CFString) ?? ""
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"

        guard let text = AXHelpers.stringValue(element, kAXValueAttribute as CFString) else { return nil }
        guard let selection = selectedRange(element) else { return nil }

        let windowID = AXHelpers.copyElement(element, kAXWindowAttribute as CFString)
            .flatMap { AXHelpers.stringValue($0, kAXTitleAttribute as CFString) } ?? ""

        let target = InlineTarget(
            pid: app.processIdentifier,
            bundleID: app.bundleIdentifier ?? "",
            windowID: windowID,
            elementID: elementID(element, role: role, subrole: subrole),
            elementRevision: revisionToken(text: text, selection: selection)
        )

        return InlineFieldReading(
            element: element,
            target: target,
            text: text,
            selection: selection,
            role: role.isEmpty ? subrole : role,
            secure: secure
        )
    }

    static func isEditable(role: String) -> Bool { editableRoles.contains(role) }

    static func selectedRange(_ element: AXUIElement) -> NSRange? {
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXSelectedTextRangeAttribute as CFString, &rangeRef
        ) == .success, let rangeRef else { return nil }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(rangeRef as! AXValue, .cfRange, &range) else { return nil }
        guard range.location >= 0, range.length >= 0 else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    /// Stable-enough identity for one element within its window. AX exposes no
    /// durable element id, so this combines what is stable across reads of the
    /// same field. It is deliberately not the value: identity must survive the
    /// user typing.
    private static func elementID(_ element: AXUIElement, role: String, subrole: String) -> String {
        let label = AXHelpers.stringValue(element, kAXIdentifierAttribute as CFString)
            ?? AXHelpers.stringValue(element, kAXPlaceholderValueAttribute as CFString)
            ?? AXHelpers.stringValue(element, kAXDescriptionAttribute as CFString)
            ?? ""
        return "\(role).\(subrole).\(label)"
    }

    /// Change token for the field's text. Two readings sharing it describe the
    /// same text with the same caret, which is exactly the condition under
    /// which an offer is still about what the user is looking at.
    static func revisionToken(text: String, selection: NSRange) -> String {
        "\(digest(of: text)):\(selection.location):\(selection.length)"
    }

    /// SHA-256, first 16 hex characters. Matches the shape the core documents
    /// in docs/bridge-protocol.md (its sample is the empty-string hash), but
    /// the exact string the core hashes is not specified there, so this is NOT
    /// relied on as the safety check -- see `validate` below.
    static func digest(of text: String) -> String {
        let hash = SHA256.hash(data: Data(text.utf8))
        return hash.compactMap { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    // MARK: - Validation

    enum ValidationFailure: Equatable {
        case noField
        case targetChanged
        case textChanged
        case selectionMoved
        case rangeOutOfBounds
        case secureField
        case notEditable
    }

    /// Revalidates a live reading against the offer immediately before the
    /// edit. Criterion 3: this runs both before the acceptance request and
    /// again on its reply, so a field that changed in between is never edited.
    ///
    /// The gate is live content equality over the replaced range and the text
    /// around it, not the core's digest. Content equality is strictly stronger
    /// than a 64-bit hash comparison and needs no shared hashing rule, so a
    /// mismatch in the core's digest convention cannot turn into a wrong edit.
    static func validate(reading: InlineFieldReading, against offer: InlineOffer, expectedText: String) -> ValidationFailure? {
        if reading.secure { return .secureField }
        if !isEditable(role: reading.role) { return .notEditable }
        if reading.target != offer.target { return .targetChanged }

        let units = reading.text.utf16.count
        guard offer.replaceStart >= 0,
              offer.replaceEnd >= offer.replaceStart,
              offer.replaceEnd <= units
        else { return .rangeOutOfBounds }

        if reading.text != expectedText { return .textChanged }

        // The caret must still be where the completion was computed for.
        let selection = reading.selection
        guard selection.location == offer.replaceStart,
              selection.location + selection.length == offer.replaceEnd
        else { return .selectionMoved }

        return nil
    }

    // MARK: - Writing

    enum InsertFailure: Error, Equatable {
        case validation(ValidationFailure)
        case couldNotSetSelection
        case couldNotSetText
        case verificationFailed
    }

    /// Applies the edit using the field's own text-editing path.
    ///
    /// Setting `kAXSelectedText` replaces the selection the way a keystroke
    /// would, so the host app registers its own undo group and Cmd-Z restores
    /// the field. Setting `kAXValue` for the whole field would be simpler and
    /// is what we deliberately do not do: it replaces the field wholesale,
    /// loses the app's undo granularity, and would make a claim of native undo
    /// false. The clipboard is never touched, so there is nothing to restore
    /// and no way to clobber newer user clipboard content.
    @discardableResult
    static func apply(offer: InlineOffer, expectedText: String) -> Result<String, InsertFailure> {
        guard let reading = readFocusedField() else { return .failure(.validation(.noField)) }
        if let failure = validate(reading: reading, against: offer, expectedText: expectedText) {
            return .failure(.validation(failure))
        }

        let range = CFRange(location: offer.replaceStart, length: offer.replaceEnd - offer.replaceStart)
        var mutableRange = range
        guard let rangeValue = AXValueCreate(.cfRange, &mutableRange) else {
            return .failure(.couldNotSetSelection)
        }
        guard AXUIElementSetAttributeValue(
            reading.element, kAXSelectedTextRangeAttribute as CFString, rangeValue
        ) == .success else { return .failure(.couldNotSetSelection) }

        guard AXUIElementSetAttributeValue(
            reading.element, kAXSelectedTextAttribute as CFString, offer.replacement as CFTypeRef
        ) == .success else { return .failure(.couldNotSetText) }

        // Read back: an AX call can report success and change nothing.
        guard let after = AXHelpers.stringValue(reading.element, kAXValueAttribute as CFString) else {
            return .failure(.verificationFailed)
        }
        let expected = applying(offer: offer, to: expectedText)
        guard after == expected else { return .failure(.verificationFailed) }
        return .success(after)
    }

    /// The text the field should hold after the edit. Pure, so the expected
    /// result is computed the same way in tests and at runtime.
    static func applying(offer: InlineOffer, to text: String) -> String {
        let units = Array(text.utf16)
        guard offer.replaceStart >= 0,
              offer.replaceEnd >= offer.replaceStart,
              offer.replaceEnd <= units.count
        else { return text }
        let head = String(utf16CodeUnits: Array(units[0..<offer.replaceStart]), count: offer.replaceStart)
        let tailCount = units.count - offer.replaceEnd
        let tail = String(utf16CodeUnits: Array(units[offer.replaceEnd...]), count: tailCount)
        return head + offer.replacement + tail
    }
}
