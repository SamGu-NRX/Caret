import Foundation

/// The check that runs immediately before an accepted inline edit is applied.
///
/// Caret's popover takes key focus while an offer is visible, so the target the
/// offer was built for is no longer the focused element by the time the user
/// presses Tab. The original target is therefore carried forward explicitly and
/// revalidated here: same process, window and element, same content, and a
/// range that still lies inside the live value.
///
/// This type decides; it does not write. Insertion is deliberately not
/// implemented in this phase — see `docs/` notes in the wiring summary — so
/// there is no path that can modify a field without these guards having passed.
public enum InsertionGuard {
    public enum Rejection: Error, Equatable {
        case noLiveTarget
        case targetMoved(expected: TargetIdentity, live: TargetIdentity)
        case contentChanged(expectedDigest: String)
        case rangeOutsideValue(start: Int, end: Int, valueLength: Int)
        case rangeSplitsCharacter(start: Int, end: Int)
        case offerExpired(ageSeconds: Double, limit: Double)
        case secureField
    }

    /// What the app reads back from the live field at acceptance time.
    public struct LiveField: Equatable, Sendable {
        public var target: TargetIdentity
        public var value: String
        public var secure: Bool

        public init(target: TargetIdentity, value: String, secure: Bool) {
            self.target = target
            self.value = value
            self.secure = secure
        }
    }

    /// The exact text the app would write, with the range it occupies.
    public struct ApprovedEdit: Equatable, Sendable {
        public var target: TargetIdentity
        public var replaceStart: Int
        public var replaceEnd: Int
        public var replacement: String
        /// What the value becomes. Computed here so the caller writes a value
        /// it did not assemble itself.
        public var resultingValue: String
    }

    /// Validates an accepted edit against the field as it is right now.
    ///
    /// `originalDigest` covers the window the offer was built from, not the
    /// whole value, so it is compared against the same window: the value's
    /// prefix up to the edit is not what the judge saw.
    public static func approve(
        edit: InlineEdit,
        live: LiveField,
        windowOffset: Int,
        windowLength: Int,
        createdAt: Date,
        now: Date = Date(),
        maxAgeSeconds: Double = 30
    ) -> Result<ApprovedEdit, Rejection> {
        guard !live.secure else { return .failure(.secureField) }
        guard live.target == edit.target else {
            return .failure(.targetMoved(expected: edit.target, live: live.target))
        }

        let age = now.timeIntervalSince(createdAt)
        guard age <= maxAgeSeconds else {
            return .failure(.offerExpired(ageSeconds: age, limit: maxAgeSeconds))
        }

        let total = UTF16Text.length(live.value)
        guard edit.replaceStart >= 0, edit.replaceEnd >= edit.replaceStart, edit.replaceEnd <= total else {
            return .failure(.rangeOutsideValue(start: edit.replaceStart, end: edit.replaceEnd, valueLength: total))
        }

        // Same window the offer was built from, re-read from the live value.
        guard let window = UTF16Text.slice(
            live.value,
            start: windowOffset,
            end: min(total, windowOffset + windowLength)
        ) else {
            return .failure(.rangeOutsideValue(start: windowOffset, end: windowOffset + windowLength, valueLength: total))
        }
        guard UTF16Text.digest(window) == edit.originalDigest else {
            return .failure(.contentChanged(expectedDigest: edit.originalDigest))
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
