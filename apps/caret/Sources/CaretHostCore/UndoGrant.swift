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
    /// The text of `priorValue` the write replaced, at `insertedStart`: empty for an insert at the
    /// caret, the selection's text for one that replaced a selection. ⌘Z puts it back.
    public var replacedText: String = ""
    /// Caret could not confirm the write (S2): ⌘Z reads the field and applies S1's ruling to it
    /// (`UnconfirmedInsert`) instead of requiring `writtenValue` exactly.
    public var unconfirmed = false
    /// A read after the write found only a proper prefix of the inserted text (S1's partial write).
    public var partialWrite = false
    public var origin: FillOrigin?
    /// Set when the helper's executor made the writes (a fill pop-up's run). ⌘Z then asks the
    /// helper to undo that task (`taskControl undo`), which restores what its ledger recorded; the
    /// host reverts nothing itself, and the value fields above are empty.
    public var taskID: String?
    /// Set for a writing fix: the edit that puts the original back over exactly the replaced range,
    /// as `RangeEdit.verify` built it. ⌘Z runs it through the same range guard as the fix, on its
    /// own `HostAuthority` grant taken at the key; `UndoGuard`, which reverts an insertion, does not
    /// apply.
    public var rangeUndo: RangeEdit?
    /// How a writing fix's ⌘Z reverts it: Caret's AX restore, or the app's own Undo where that is
    /// proven (`NativeUndoApps`). Only range grants use it.
    public var strategy: UndoStrategy = .axRestore
    public var createdAt: Date
    public var lifetimeSeconds: Double

    /// The grant for a helper task's writes. `target` is the field the offer was taken in, so only
    /// a ⌘Z headed for that app takes it.
    /// The grant for a writing fix. `target` is the field as the fix left it.
    public static func range(
        _ undo: RangeEdit, priorValue: String, writtenValue: String, writeID: UInt64, strategy: UndoStrategy = .axRestore, createdAt: Date = Date()
    ) -> UndoGrant {
        var grant = UndoGrant(
            target: undo.target, priorValue: priorValue, writtenValue: writtenValue, insertedStart: undo.replace.start,
            insertedLength: undo.replace.length, origin: nil, writeID: writeID, createdAt: createdAt
        )
        grant.rangeUndo = undo
        grant.strategy = strategy
        return grant
    }

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

    /// The grant for an insert, made before anything is written (S2) and armed with the field as
    /// the guard approved it: its value, and the range and text of the edit. `UnconfirmedInsert.grant`
    /// decides after the write whether it is kept.
    public static func armed(
        target: TargetIdentity, priorValue: String, edit: InsertionGuard.ApprovedEdit, origin: FillOrigin?, writeID: UInt64
    ) -> UndoGrant {
        var written = target
        written.elementRevision = UTF16Text.digest(edit.resultingValue)
        var grant = UndoGrant(
            target: written, priorValue: priorValue, writtenValue: edit.resultingValue, insertedStart: edit.replaceStart,
            insertedLength: UTF16Text.length(edit.replacement), origin: origin, writeID: writeID
        )
        // The guard approved the range against `priorValue`, so the slice exists.
        grant.replacedText = UTF16Text.slice(priorValue, start: edit.replaceStart, end: edit.replaceEnd) ?? ""
        return grant
    }

    /// The insert this grant records, when its fields agree: `writtenValue` is `priorValue` with
    /// `replacedText` at `insertedStart` replaced by the inserted text.
    var intent: UnconfirmedInsert.Intent? {
        let end = insertedStart + UTF16Text.length(replacedText)
        let insertedEnd = insertedStart + insertedLength
        guard insertedLength >= 0,
              let head = UTF16Text.slice(priorValue, start: 0, end: insertedStart),
              UTF16Text.slice(priorValue, start: insertedStart, end: end) == replacedText,
              let tail = UTF16Text.slice(priorValue, start: end, end: UTF16Text.length(priorValue)),
              let inserted = UTF16Text.slice(writtenValue, start: insertedStart, end: insertedEnd),
              head + inserted + tail == writtenValue
        else { return nil }
        return UnconfirmedInsert.Intent(before: priorValue, start: insertedStart, end: end, replacement: inserted)
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
        /// An unconfirmed write's field reads as it did before it: nothing landed, nothing to undo.
        case nothingWritten
        /// Right before the restore, the selection was not exactly the span Caret selected.
        case selectionMoved
        /// A key or click came after ⌘Z and before the restore.
        case inputDuringUndo

        public var code: String {
            switch self {
            case .targetMoved: return "targetMoved"
            case .fieldChanged: return "fieldChanged"
            case .spanInvalid: return "spanInvalid"
            case .secureField: return "secureField"
            case .nothingWritten: return "nothingWritten"
            case .selectionMoved: return "selectionMoved"
            case .inputDuringUndo: return "inputDuringUndo"
            }
        }
    }

    /// Replace `start..<start+length` of the live value with `restore`; the result must be
    /// `expectedValue`.
    public struct Revert: Equatable, Sendable {
        public var start: Int
        public var length: Int
        public var expectedValue: String
        /// The text the write replaced: empty for an insert at the caret.
        public var restore: String = ""
        /// Only a prefix of the write's text is taken out (S1's partial write).
        public var partialWrite = false
    }

    public static func approve(_ grant: UndoGrant, live: InsertionGuard.LiveField) -> Result<Revert, Rejection> {
        guard !live.secure else { return .failure(.secureField) }
        var expected = grant.target
        var actual = live.target
        expected.elementRevision = ""
        actual.elementRevision = ""
        guard expected == actual else { return .failure(.targetMoved) }
        // S2: an unconfirmed write is judged by the read just made, not by the earlier one, since
        // keys posted before a stop can land after it and the user can edit since. Only S1's three
        // recognized states are reverted; the field is otherwise left as it is.
        if grant.unconfirmed {
            guard let intent = grant.intent else { return .failure(.spanInvalid) }
            switch UnconfirmedInsert.classify(intent, held: live.value) {
            case .original:
                return .failure(.nothingWritten)
            case .whole:
                return .success(Revert(start: intent.start, length: grant.insertedLength, expectedValue: grant.priorValue, restore: grant.replacedText))
            case .partial(let inserted):
                return .success(Revert(
                    start: intent.start, length: inserted, expectedValue: grant.priorValue, restore: grant.replacedText, partialWrite: true
                ))
            case .unrecognized:
                return .failure(.fieldChanged)
            }
        }
        guard live.target.elementRevision == UTF16Text.digest(grant.writtenValue), UTF16Text.same(live.value, grant.writtenValue) else {
            return .failure(.fieldChanged)
        }
        let total = UTF16Text.length(live.value)
        let end = grant.insertedStart + grant.insertedLength
        guard grant.insertedStart >= 0, grant.insertedLength >= 0, end <= total,
              let prefix = UTF16Text.slice(live.value, start: 0, end: grant.insertedStart),
              let suffix = UTF16Text.slice(live.value, start: end, end: total),
              prefix + grant.replacedText + suffix == grant.priorValue
        else { return .failure(.spanInvalid) }
        return .success(Revert(start: grant.insertedStart, length: grant.insertedLength, expectedValue: grant.priorValue, restore: grant.replacedText))
    }

    /// The last check before the restore writes, after the span is selected and the field read
    /// again: it holds exactly the value `approve` judged, its selection is exactly the span to
    /// replace, and no key or click came since ⌘Z (`quiet`). Anything else, or a selection that
    /// cannot be read, proves nothing about what the write would delete, so nothing is written.
    public static func recheck(_ revert: Revert, approvedValue: String, now: InsertionGuard.LiveField, quiet: Bool) -> Rejection? {
        guard quiet else { return .inputDuringUndo }
        guard UTF16Text.same(now.value, approvedValue) else { return .fieldChanged }
        guard now.selection == UTF16Selection(start: revert.start, end: revert.start + revert.length) else { return .selectionMoved }
        return nil
    }

    /// Whether the field reads exactly as the revert means it to, unit for unit.
    public static func restored(_ revert: Revert, value: String) -> Bool { UTF16Text.same(value, revert.expectedValue) }
}
