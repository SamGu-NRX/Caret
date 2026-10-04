import Foundation

/// The one write ⌘Z may revert, held by `OfferArbiter` while its result toast is visible.
///
/// `SURFACES.md` section 6: ⌘Z belongs to Caret only while the toast is up, because the user
/// reached that state with Tab and the host app has no undo step of its own for it yet. The
/// moment the toast goes, ⌘Z is the host's again.
public struct UndoGrant: Equatable, Sendable {
    /// Toast lifetime from `SURFACES.md` section 6.
    public static let defaultLifetime: Double = 5

    /// Assigned by `OfferArbiter.showToast`.
    public internal(set) var id: UInt64 = 0
    /// The executor's id for the write, under which it keeps the written element, so ⌘Z can find
    /// the element the moment the grant is visible.
    public var writeID: UInt64
    /// The field as the write left it: `elementRevision` is the digest of `writtenValue`.
    public var target: TargetIdentity
    public var priorValue: String
    public var writtenValue: String
    /// The UTF-16 span the write inserted, as offsets into `writtenValue`.
    public var insertedStart: Int
    public var insertedLength: Int
    public var origin: FillOrigin?
    /// Set when the helper's executor made the writes (a fill pop-up's run). ⌘Z then asks the
    /// helper to undo that task (`taskControl undo`), which restores what its ledger recorded; the
    /// host reverts nothing itself, and the value fields above are empty.
    public var taskID: String?
    public var createdAt: Date
    public var lifetimeSeconds: Double

    /// The grant for a helper task's writes. `target` is the field the offer was taken in, so only
    /// a ⌘Z headed for that app takes it.
    public static func task(_ taskID: String, target: TargetIdentity, createdAt: Date = Date(), lifetimeSeconds: Double = UndoGrant.defaultLifetime) -> UndoGrant {
        var grant = UndoGrant(
            target: target, priorValue: "", writtenValue: "", insertedStart: 0, insertedLength: 0, origin: nil,
            createdAt: createdAt, lifetimeSeconds: lifetimeSeconds
        )
        grant.taskID = taskID
        return grant
    }

    public init(
        target: TargetIdentity, priorValue: String, writtenValue: String, insertedStart: Int,
        insertedLength: Int, origin: FillOrigin?, writeID: UInt64 = 0, createdAt: Date = Date(),
        lifetimeSeconds: Double = UndoGrant.defaultLifetime
    ) {
        self.writeID = writeID
        self.target = target
        self.priorValue = priorValue
        self.writtenValue = writtenValue
        self.insertedStart = insertedStart
        self.insertedLength = insertedLength
        self.origin = origin
        self.createdAt = createdAt
        self.lifetimeSeconds = lifetimeSeconds
    }

    public func isExpired(at now: Date) -> Bool {
        now.timeIntervalSince(createdAt) > lifetimeSeconds
    }
}

/// Decides whether an undo may run against the live field. Like `InsertionGuard`, it decides and
/// does not write.
public enum UndoGuard {
    public enum Rejection: Error, Equatable, Sendable {
        /// A different element, window or app now holds focus at the grant's target.
        case targetMoved
        /// The field no longer holds exactly what Caret wrote: the user or the app changed it.
        case fieldChanged
        /// The recorded span does not describe the written value (a bug, not a user action).
        case spanInvalid
        case secureField

        public var code: String {
            switch self {
            case .targetMoved: return "targetMoved"
            case .fieldChanged: return "fieldChanged"
            case .spanInvalid: return "spanInvalid"
            case .secureField: return "secureField"
            }
        }
    }

    /// Remove `start..<start+length` from the live value; the result must be `expectedValue`.
    public struct Revert: Equatable, Sendable {
        public var start: Int
        public var length: Int
        public var expectedValue: String
    }

    public static func approve(_ grant: UndoGrant, live: InsertionGuard.LiveField) -> Result<Revert, Rejection> {
        guard !live.secure else { return .failure(.secureField) }
        var expected = grant.target
        var actual = live.target
        expected.elementRevision = ""
        actual.elementRevision = ""
        guard expected == actual else { return .failure(.targetMoved) }
        guard live.target.elementRevision == UTF16Text.digest(grant.writtenValue), live.value == grant.writtenValue else {
            return .failure(.fieldChanged)
        }
        let total = UTF16Text.length(live.value)
        let end = grant.insertedStart + grant.insertedLength
        guard grant.insertedStart >= 0, grant.insertedLength >= 0, end <= total,
              let prefix = UTF16Text.slice(live.value, start: 0, end: grant.insertedStart),
              let suffix = UTF16Text.slice(live.value, start: end, end: total),
              prefix + suffix == grant.priorValue
        else { return .failure(.spanInvalid) }
        return .success(Revert(start: grant.insertedStart, length: grant.insertedLength, expectedValue: grant.priorValue))
    }
}
