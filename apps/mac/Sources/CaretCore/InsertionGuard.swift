import Foundation

/// The check that runs immediately before an accepted inline edit is applied.
///
/// `original_digest` covers only the text the edit replaces, not the
/// surrounding window: `caret/router.py::build_inline_offer` sets it to
/// `digest(selected_text)` with a selection and `digest("")` without one. So an
/// insertion at the caret carries the digest of the empty string, and the check
/// here is over exactly `replace_start..<replace_end` in the live value.
///
/// Whole-field change is caught separately, by `target.element_revision`, which
/// the capture side sets to the digest of the entire value.
///
/// This type decides; it does not write. Insertion belongs to the Tab owner.
public enum InsertionGuard {
    public enum Rejection: Error, Equatable {
        case targetMoved(expected: TargetIdentity, live: TargetIdentity)
        /// The whole field changed: live `element_revision` no longer matches.
        case fieldContentChanged(expected: String, live: String)
        /// The replaced span itself changed.
        case replacedTextChanged(expectedDigest: String, liveDigest: String)
        /// The user moved the caret or altered the selection after the offer.
        case selectionMoved(expected: TextSelection, live: TextSelection)
        case rangeOutsideValue(start: Int, end: Int, valueLength: Int)
        case rangeSplitsCharacter(start: Int, end: Int)
        case offerExpired(ageSeconds: Double, limit: Double)
        case secureField
    }

    /// What the app reads back from the live field at acceptance time.
    ///
    /// `target` must be produced by the same capture that built the offer, so
    /// its `elementRevision` is the live full-value digest.
    public struct LiveField: Equatable, Sendable {
        public var target: TargetIdentity
        public var value: String
        public var selection: TextSelection?
        public var secure: Bool

        public init(target: TargetIdentity, value: String, selection: TextSelection? = nil, secure: Bool = false) {
            self.target = target
            self.value = value
            self.selection = selection
            self.secure = secure
        }
    }

    public struct ApprovedEdit: Equatable, Sendable {
        public var target: TargetIdentity
        public var replaceStart: Int
        public var replaceEnd: Int
        public var replacement: String
        public var resultingValue: String
    }

    public static func approve(
        edit: InlineEdit,
        live: LiveField,
        createdAt: Date,
        now: Date = Date(),
        maxAgeSeconds: Double = 30
    ) -> Result<ApprovedEdit, Rejection> {
        guard !live.secure else { return .failure(.secureField) }

        // Identity without the content token: a changed field is reported as a
        // content change, not as a different field.
        var expectedIdentity = edit.target
        var liveIdentity = live.target
        expectedIdentity.elementRevision = ""
        liveIdentity.elementRevision = ""
        guard expectedIdentity == liveIdentity else {
            return .failure(.targetMoved(expected: edit.target, live: live.target))
        }
        guard edit.target.elementRevision == live.target.elementRevision else {
            return .failure(.fieldContentChanged(
                expected: edit.target.elementRevision,
                live: live.target.elementRevision
            ))
        }

        let age = now.timeIntervalSince(createdAt)
        guard age <= maxAgeSeconds else {
            return .failure(.offerExpired(ageSeconds: age, limit: maxAgeSeconds))
        }

        let total = UTF16Text.length(live.value)
        guard edit.replaceStart >= 0, edit.replaceEnd >= edit.replaceStart, edit.replaceEnd <= total else {
            return .failure(.rangeOutsideValue(start: edit.replaceStart, end: edit.replaceEnd, valueLength: total))
        }

        if let selection = live.selection {
            let expected = TextSelection(start: edit.replaceStart, end: edit.replaceEnd)
            guard selection == expected else {
                return .failure(.selectionMoved(expected: expected, live: selection))
            }
        }

        guard let replaced = UTF16Text.slice(live.value, start: edit.replaceStart, end: edit.replaceEnd) else {
            return .failure(.rangeSplitsCharacter(start: edit.replaceStart, end: edit.replaceEnd))
        }
        let liveDigest = UTF16Text.digest(replaced)
        guard liveDigest == edit.originalDigest else {
            return .failure(.replacedTextChanged(expectedDigest: edit.originalDigest, liveDigest: liveDigest))
        }

        guard let prefix = UTF16Text.slice(live.value, start: 0, end: edit.replaceStart),
              let suffix = UTF16Text.slice(live.value, start: edit.replaceEnd, end: total)
        else {
            return .failure(.rangeSplitsCharacter(start: edit.replaceStart, end: edit.replaceEnd))
        }

        return .success(ApprovedEdit(
            target: edit.target,
            replaceStart: edit.replaceStart,
            replaceEnd: edit.replaceEnd,
            replacement: edit.replacement,
            resultingValue: prefix + edit.replacement + suffix
        ))
    }
}
