import Foundation

/// How a ghost completion fits at the caret, and why it was not drawn when it was not.
///
/// A9 measured 38 of 76 engine offers in the claim form's Promo code with no placement. KeyType's
/// renderer declines a completion wider than the room left on a single-line field
/// (`shouldSuppressInlineSingleLineOverflow`), and once a typed sentence reaches the field's right
/// edge that is every completion. `SURFACES.md` section 1, "A narrow field", asks for the capsule
/// below the caret instead, the surface KeyType already draws for mid-text completions (ADR-048).
public enum GhostFit {
    /// What happens to a completion that does not fit on the caret's line.
    public enum OverflowRule: String, Codable, Sendable {
        /// Draw it in the capsule under the caret (the default).
        case capsule
        /// Draw nothing, as KeyType does. Kept to measure the before row on the same build
        /// (`--ghost-overflow drop`).
        case drop
    }

    /// Why nothing was drawn.
    public enum Cause: String, Codable, Sendable {
        /// The field reported no caret rect.
        case noCaret
        /// KeyType's resolver refused the caret (an app policy that hides overlays, or a code
        /// editor's unreliable line origin).
        case resolverRefused
        /// Wider than the room after the caret on a single-line field.
        case singleLineOverflow
        /// Wider than the room after the caret in a text-mirror app with an estimated caret.
        case mirrorOverflow
        /// KeyType's window was asked to draw and stayed hidden.
        case windowDeclined
        /// The capsule would hang below the bottom of the caret's display.
        case capsuleOffScreen
    }

    public enum Outcome: String, Codable, Sendable {
        case inline, capsule, mirror
        /// A completion too wide for the line, drawn in the capsule instead.
        case overflowCapsule
        case declined
    }

    public enum Decision: Equatable, Sendable {
        /// Draw as KeyType placed it.
        case asPlaced
        /// Draw in the capsule.
        case capsule
        case decline(Cause)
    }

    /// The decision for a completion KeyType has placed. `inlineOverflows` and `mirrorOverflows`
    /// are KeyType's own suppression tests; `canMirror` means the text mirror draws it, which
    /// handles its own overflow.
    ///
    /// A mirror overflow stays declined: KeyType suppresses it only where the caret is derived or
    /// estimated, and a capsule hung from a guessed caret could land on the wrong line.
    public static func decide(inlineOverflows: Bool, mirrorOverflows: Bool, canMirror: Bool, rule: OverflowRule) -> Decision {
        guard !canMirror else { return .asPlaced }
        if mirrorOverflows { return .decline(.mirrorOverflow) }
        guard inlineOverflows else { return .asPlaced }
        return rule == .capsule ? .capsule : .decline(.singleLineOverflow)
    }

    /// One attempt to draw a completion, for the debug state: geometry only, never the text.
    public struct Record: Codable, Equatable, Sendable {
        public var outcome: Outcome
        public var cause: Cause?
        /// Points the completion needs on one line.
        public var textWidth: Double
        /// Points between the caret and the field's trailing edge; nil without a field frame.
        public var room: Double?
        public var fieldHeight: Double?
        /// KeyType's caret quality: exact, derived, estimated or unknown.
        public var caretQuality: String?

        public init(outcome: Outcome, cause: Cause?, textWidth: Double, room: Double?, fieldHeight: Double?, caretQuality: String?) {
            self.outcome = outcome
            self.cause = cause
            self.textWidth = textWidth
            self.room = room
            self.fieldHeight = fieldHeight
            self.caretQuality = caretQuality
        }
    }

    /// The last records kept in the debug state, enough for one acceptance run's 54 keys.
    public static let keptRecords = 128
}
