import Foundation

/// One insert as the insertion queue runs it (S2): its undo grant armed before the first write,
/// whatever the claim's kind, and what the write leaves once it verified or failed.
/// `InsertionExecutor.run` does the Accessibility and key work between the two; the decisions are
/// here, so they are tested without an app.
public struct InsertAttempt: Equatable, Sendable {
    /// The grant as armed before writing: the field as the guard approved it.
    public let armed: UndoGrant
    public let intent: UnconfirmedInsert.Intent

    /// Arms the grant. `writeID` is the id the queue binds the written element under, before any
    /// write, so ⌘Z finds it even for a write stopped halfway.
    public init(claim: Claim, before: InsertionGuard.LiveField, approved: InsertionGuard.ApprovedEdit, writeID: UInt64) {
        armed = UndoGrant.armed(target: before.target, priorValue: before.value, edit: approved, origin: claim.offer.kind.fillOrigin, writeID: writeID)
        intent = UnconfirmedInsert.Intent(before: before.value, start: approved.replaceStart, end: approved.replaceEnd, replacement: approved.replacement)
    }

    /// Whether the field must be read before the result: something that changes text reached the
    /// app and the write did not verify. A paste found in another field leaves the approved one as
    /// it was read, and that failure already names the field to check.
    public static func needsRead(verified: Bool, dispatched: Bool, strayField: String?) -> Bool {
        !verified && dispatched && strayField == nil
    }

    /// S1's state of the field read after the write; `held` nil is unreadable.
    public func report(held: String?) -> UnconfirmedInsert.Report {
        UnconfirmedInsert.read(intent, held: held)
    }

    /// The grant the write leaves (`UnconfirmedInsert.grant`), stamped `now` so ⌘Z lives its full
    /// lifetime from the result.
    public func grant(verified: Bool, report: UnconfirmedInsert.Report?, at now: Date) -> UndoGrant? {
        guard var grant = UnconfirmedInsert.grant(armed: armed, verified: verified, report: report) else { return nil }
        grant.createdAt = now
        return grant
    }
}
