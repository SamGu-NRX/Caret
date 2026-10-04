import Foundation

/// A guarded replacement of one range of a field's text, bound to the exact field state it was
/// offered for (`action-engine-v2.md` section 7, "Guarded replacement").
///
/// It binds the observed selection and the replaced range separately. A spelling fix behind the
/// caret replaces a word the user never selected, so the guard cannot equate the two the way
/// `InsertionGuard` does for text appended at the caret. Each validation checks, in order: the
/// field is not secure and not composing (IME), the same element, the same full value, the offer
/// is fresh, the selection, the range's bounds and character boundaries, the replaced text's
/// digest, and that the replacement cannot merge with its neighbors.
///
/// This type decides; it does not write. An executor runs it three times:
/// 1. `validate(live, phase: .observed)` before touching the field;
/// 2. `validate(live, phase: .rangeSelected)` after selecting `replace` for an AX write, the one
///    selection change acceptance authorizes;
/// 3. `verify(after:)` on a fresh read of the whole value once written.
/// `verify` returns the undo, itself a `RangeEdit` that goes through the same three steps.
public struct RangeEdit: Equatable, Sendable {
    /// The field when the edit was made: `elementRevision` is the digest of its whole value.
    public var target: TargetIdentity
    /// The selection the user had. It must be unchanged at acceptance.
    public var observedSelection: UTF16Selection
    /// The text replaced, in the observed value.
    public var replace: UTF16Span
    /// `UTF16Text.digest` of the replaced text.
    public var originalDigest: String
    /// The replaced text itself, kept in memory for the undo and the preview. Never logged.
    public var original: String
    public var replacement: String
    public var language: String
    public var createdAt: Date
    public var maxAgeSeconds: Double

    public static let defaultMaxAge: Double = 30

    /// What the host reads back from the field.
    public struct Live: Equatable, Sendable {
        /// From the same reader that built the edit, so `elementRevision` is the live digest.
        public var target: TargetIdentity
        public var value: String
        /// Nil when the field did not report one.
        public var selection: UTF16Selection?
        public var secure: Bool
        /// An input method has marked (uncommitted) text in the field.
        public var composing: Bool

        public init(target: TargetIdentity, value: String, selection: UTF16Selection?, secure: Bool = false, composing: Bool = false) {
            self.target = target
            self.value = value
            self.selection = selection
            self.secure = secure
            self.composing = composing
        }
    }

    public enum Phase: Equatable, Sendable {
        /// Before acceptance touches anything: the user's selection must be the observed one.
        case observed
        /// After the executor selected `replace` to write over it.
        case rangeSelected
    }

    public enum Refusal: Error, Equatable, Sendable {
        case secureField
        /// An input method is composing; replacing text under it would fight the IME.
        case composing
        /// A different element, window or app.
        case targetMoved
        /// The field's whole value changed since the edit was made.
        case revisionChanged
        case expired(ageSeconds: Double, limit: Double)
        case selectionUnreadable
        case selectionMoved(expected: UTF16Selection, live: UTF16Selection)
        /// The selection is partly inside the replaced range, so neither side of it is sure.
        case selectionStraddlesRange
        case rangeOutsideValue(UTF16Span, valueLength: Int)
        /// A bound falls inside a character: a surrogate pair, a base letter and its combining
        /// mark, an emoji sequence or a flag.
        case rangeSplitsCharacter(offset: Int)
        /// The replaced text is not what the edit was made for.
        case originalChanged
        /// The replacement would join the character before or after it into a new one (it starts
        /// with a combining mark, or ends with a joiner).
        case replacementJoinsNeighbor
        /// Bidi overrides or control characters in the replacement.
        case replacementHasControlCharacters
        /// The replacement equals the original; there is nothing to apply and no undo to record.
        case noChange
        /// After writing, the field does not hold the expected value.
        case writeMismatch

        /// Stable short name for logs and the debug socket. Carries no field text.
        public var code: String {
            switch self {
            case .secureField: return "secureField"
            case .composing: return "composing"
            case .targetMoved: return "targetMoved"
            case .revisionChanged: return "revisionChanged"
            case .expired: return "expired"
            case .selectionUnreadable: return "selectionUnreadable"
            case .selectionMoved: return "selectionMoved"
            case .selectionStraddlesRange: return "selectionStraddlesRange"
            case .rangeOutsideValue: return "rangeOutsideValue"
            case .rangeSplitsCharacter: return "rangeSplitsCharacter"
            case .originalChanged: return "originalChanged"
            case .replacementJoinsNeighbor: return "replacementJoinsNeighbor"
            case .replacementHasControlCharacters: return "replacementHasControlCharacters"
            case .noChange: return "noChange"
            case .writeMismatch: return "writeMismatch"
            }
        }
    }

    /// An edit cleared to apply against the field as it was read.
    public struct Approved: Equatable, Sendable {
        public var edit: RangeEdit
        /// The whole value after the replacement.
        public var resultingValue: String
        /// Where the replacement sits in `resultingValue`.
        public var inserted: UTF16Span
        /// The user's selection carried through the edit: unchanged before the range, shifted
        /// after it, and over the replacement when it was exactly the range.
        public var resultingSelection: UTF16Selection
    }

    /// Builds an edit from a field as read, and checks it against that same read: an edit that
    /// would be refused at acceptance is never offered.
    public static func make(
        live: Live, replace: UTF16Span, replacement: String, language: String = "en",
        now: Date = Date(), maxAgeSeconds: Double = RangeEdit.defaultMaxAge
    ) -> Result<RangeEdit, Refusal> {
        let total = UTF16Text.length(live.value)
        guard replace.start >= 0, replace.end >= replace.start, replace.end <= total else {
            return .failure(.rangeOutsideValue(replace, valueLength: total))
        }
        guard let selection = live.selection else { return .failure(.selectionUnreadable) }
        guard let original = UTF16Text.slice(live.value, start: replace.start, end: replace.end) else {
            return .failure(.rangeSplitsCharacter(offset: replace.start))
        }
        var target = live.target
        target.elementRevision = UTF16Text.digest(live.value)
        let edit = RangeEdit(
            target: target, observedSelection: selection, replace: replace, originalDigest: UTF16Text.digest(original),
            original: original, replacement: replacement, language: language, createdAt: now, maxAgeSeconds: maxAgeSeconds
        )
        var observed = live
        observed.target = target
        return edit.validate(observed, phase: .observed, now: now).map { $0.edit }
    }

    /// Accept, or a specific refusal. See the type's comment for the order of checks.
    public func validate(_ live: Live, phase: Phase = .observed, now: Date = Date()) -> Result<Approved, Refusal> {
        guard !live.secure else { return .failure(.secureField) }
        guard !live.composing else { return .failure(.composing) }

        var expectedIdentity = target, liveIdentity = live.target
        expectedIdentity.elementRevision = ""
        liveIdentity.elementRevision = ""
        guard expectedIdentity == liveIdentity else { return .failure(.targetMoved) }
        // The reader's token and the value itself must both match: a stale token on a changed
        // value is still a changed field.
        guard target.elementRevision == live.target.elementRevision,
              UTF16Text.digest(live.value) == target.elementRevision
        else { return .failure(.revisionChanged) }

        let age = now.timeIntervalSince(createdAt)
        guard age <= maxAgeSeconds else { return .failure(.expired(ageSeconds: age, limit: maxAgeSeconds)) }

        guard let selection = live.selection else { return .failure(.selectionUnreadable) }
        let expected = phase == .observed ? observedSelection : UTF16Selection(start: replace.start, end: replace.end)
        guard selection == expected else { return .failure(.selectionMoved(expected: expected, live: selection)) }
        // The user's selection sits wholly before the range, wholly after it, or covers all of it.
        // A caret inside the range, or a selection with one end inside, is neither.
        let s = observedSelection
        let clear = s.end <= replace.start || s.start >= replace.end
            || (!s.isEmpty && s.start <= replace.start && s.end >= replace.end)
        guard clear else { return .failure(.selectionStraddlesRange) }

        let total = UTF16Text.length(live.value)
        guard replace.start >= 0, replace.end >= replace.start, replace.end <= total else {
            return .failure(.rangeOutsideValue(replace, valueLength: total))
        }
        for bound in [replace.start, replace.end] where !WritingText.isCharacterBoundary(bound, in: live.value) {
            return .failure(.rangeSplitsCharacter(offset: bound))
        }
        guard let replaced = UTF16Text.slice(live.value, start: replace.start, end: replace.end),
              UTF16Text.digest(replaced) == originalDigest
        else { return .failure(.originalChanged) }

        guard replacement != replaced else { return .failure(.noChange) }
        guard !WritingText.hasControlCharacters(replacement) else { return .failure(.replacementHasControlCharacters) }

        guard let prefix = UTF16Text.slice(live.value, start: 0, end: replace.start),
              let suffix = UTF16Text.slice(live.value, start: replace.end, end: total)
        else { return .failure(.rangeSplitsCharacter(offset: replace.start)) }
        let result = prefix + replacement + suffix
        let inserted = UTF16Span(start: replace.start, end: replace.start + UTF16Text.length(replacement))
        // The neighbors must stay the characters they were: no combining mark at the start of the
        // replacement attaching to the letter before, no joiner at its end pulling in the next.
        guard WritingText.isCharacterBoundary(inserted.start, in: result),
              WritingText.isCharacterBoundary(inserted.end, in: result),
              result.count == prefix.count + replacement.count + suffix.count
        else { return .failure(.replacementJoinsNeighbor) }

        return .success(Approved(
            edit: self, resultingValue: result, inserted: inserted,
            resultingSelection: carry(observedSelection, insertedLength: inserted.length)
        ))
    }

    /// Checks a fresh read after the write: the same element, holding exactly the expected value.
    /// Returns the undo: an edit that puts the original back over exactly the inserted range, bound
    /// to the value Caret wrote, so any later change to the field refuses it.
    public func verify(after live: Live, approved: Approved, now: Date = Date()) -> Result<RangeEdit, Refusal> {
        guard !live.secure else { return .failure(.secureField) }
        var expectedIdentity = target, liveIdentity = live.target
        expectedIdentity.elementRevision = ""
        liveIdentity.elementRevision = ""
        guard expectedIdentity == liveIdentity else { return .failure(.targetMoved) }
        guard live.value == approved.resultingValue else { return .failure(.writeMismatch) }
        var written = target
        written.elementRevision = UTF16Text.digest(approved.resultingValue)
        let undoSelection = live.selection ?? approved.resultingSelection
        return .success(RangeEdit(
            target: written, observedSelection: undoSelection, replace: approved.inserted,
            originalDigest: UTF16Text.digest(replacement), original: replacement, replacement: original,
            language: language, createdAt: now, maxAgeSeconds: UndoGrant.defaultLifetime
        ))
    }

    /// The observed selection after replacing `replace` with `insertedLength` units.
    func carry(_ selection: UTF16Selection, insertedLength: Int) -> UTF16Selection {
        let delta = insertedLength - replace.length
        if selection.end <= replace.start { return selection }
        if selection.start >= replace.end { return UTF16Selection(start: selection.start + delta, end: selection.end + delta) }
        // The selection covered the range (validated above): it now covers the replacement.
        return UTF16Selection(start: min(selection.start, replace.start), end: selection.end + delta)
    }
}
