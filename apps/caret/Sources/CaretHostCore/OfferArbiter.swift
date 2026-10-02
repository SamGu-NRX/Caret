import Foundation
import os

/// Owns the one offer Tab may take, and hands it out at most once.
///
/// The tap thread calls `handleKeyDown` for every key-down. The main thread publishes and
/// invalidates offers. The insertion queue confirms a claim against a fresh read of the field and
/// reports how insertion went. One unfair lock covers all of it; every critical section is a few
/// field assignments, so the tap callback never waits on model work or Accessibility.
///
/// Lifecycle of an offer: `publish` makes it current. A plain Tab claims it, which removes it, so
/// a second Tab finds nothing and passes through. Any other key that does not type the offer's
/// next characters removes it too. While a claim is being inserted, `publish` refuses new offers
/// so a stale snapshot cannot re-offer text that is already on its way into the field.
///
/// Key ownership follows `SURFACES.md` section 8. Two surfaces can hold keys here: the current
/// offer (ghost text or a fill value: Tab) and the result toast (⌘Z, Esc). A key headed for an app
/// other than the offer's own (`KeyStroke.targetPID`) neither takes nor dismisses anything.
public final class OfferArbiter: @unchecked Sendable {
    public enum PassReason: String, Codable, Sendable {
        /// No offer exists; the key keeps its native meaning.
        case noOffer
        /// The offer outlived `maxAgeSeconds`; it was removed.
        case expired
        /// The key typed the offer's next characters; the offer stays, shortened.
        case typedThrough
        /// The key diverged from the offer; it was removed.
        case dismissed
        /// The key is headed for a different app than the offer's (or, for a fill, its target is
        /// unknown). Nothing was taken or dismissed.
        case otherApp
        /// No offer, but the key dismissed the result toast.
        case toastDismissed
    }

    public enum Decision: Equatable, Sendable {
        /// Swallow the key and insert this claim.
        case consume(Claim)
        /// Swallow ⌘Z and revert this write.
        case undo(UndoGrant)
        /// Swallow Esc: it closed the toast.
        case closeToast
        case pass(PassReason)
    }

    public enum ClaimOutcome: Equatable, Codable, Sendable {
        case pending
        case rejected(String)
        case approved
        case inserted
        case insertFailed(String)
    }

    public struct ClaimRecord: Equatable, Codable, Sendable {
        public var claimID: UInt64
        public var offerID: UInt64
        public var claimedAt: Date
        public var insertionLength: Int
        public var outcome: ClaimOutcome
    }

    public struct Snapshot: Equatable, Sendable {
        public var current: Offer?
        public var typedSinceOffer: String
        public var lastClaim: ClaimRecord?
        public var insertingClaimID: UInt64?
        public var toast: UndoGrant?
        public var publishedCount: UInt64
        public var claimCount: UInt64
        public var refusedPublishCount: UInt64
    }

    private struct State {
        var current: Offer?
        var typedSinceOffer = ""
        var nextOfferID: UInt64 = 1
        var nextClaimID: UInt64 = 1
        var insertingClaimID: UInt64?
        /// The field state (element and revision) the last insertion started from. An offer for
        /// that state is stale by construction once the insertion lands. The whole identity, not
        /// only the revision: every empty field shares one revision, and the next field of a form
        /// must stay offerable after the first is filled.
        var consumedTarget: TargetIdentity?
        var toast: UndoGrant?
        var nextGrantID: UInt64 = 1
        var lastClaim: ClaimRecord?
        var publishedCount: UInt64 = 0
        var claimCount: UInt64 = 0
        var refusedPublishCount: UInt64 = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    public init() {}

    // MARK: - Main thread

    /// Makes `offer` the current one. Returns its id, or nil when refused because a claim is being
    /// inserted or the offer is for the field revision an insertion just consumed.
    @discardableResult
    public func publish(_ offer: Offer) -> UInt64? {
        state.withLock { s in
            guard s.insertingClaimID == nil, offer.target != s.consumedTarget else {
                s.refusedPublishCount &+= 1
                return nil
            }
            // The field has moved past the consumed state; returning to it later is a new state.
            s.consumedTarget = nil
            var stamped = offer
            stamped.id = s.nextOfferID
            s.nextOfferID &+= 1
            s.current = stamped
            s.typedSinceOffer = ""
            s.publishedCount &+= 1
            return stamped.id
        }
    }

    /// Removes the current offer. With `offerID`, only that offer; a newer one survives.
    public func invalidate(offerID: UInt64? = nil) {
        state.withLock { s in
            guard let current = s.current else { return }
            if let offerID, current.id != offerID { return }
            s.current = nil
            s.typedSinceOffer = ""
        }
    }

    /// Removes the current offer only if it is of the given kind, so the ghost-text path clearing
    /// its own state cannot take down a fill offer, or the reverse.
    public func invalidate(kind: String) {
        state.withLock { s in
            guard let current = s.current, current.kind.name == kind else { return }
            s.current = nil
            s.typedSinceOffer = ""
        }
    }

    /// Makes `grant` the write ⌘Z reverts, replacing any earlier one. Returns its id.
    @discardableResult
    public func showToast(_ grant: UndoGrant) -> UInt64 {
        state.withLock { s in
            var stamped = grant
            stamped.id = s.nextGrantID
            s.nextGrantID &+= 1
            s.toast = stamped
            return stamped.id
        }
    }

    /// Removes the toast. With `grantID`, only that one.
    public func dismissToast(grantID: UInt64? = nil) {
        state.withLock { s in
            guard let toast = s.toast else { return }
            if let grantID, toast.id != grantID { return }
            s.toast = nil
        }
    }

    // MARK: - Tap thread

    /// Decides one key-down. Constant time apart from a prefix check on the offer text.
    public func handleKeyDown(_ key: KeyStroke, now: Date = Date()) -> Decision {
        state.withLock { s in
            var dismissedToast = false
            if let toast = s.toast {
                if toast.isExpired(at: now) {
                    s.toast = nil
                } else if key.isHeaded(to: toast.target.pid) {
                    s.toast = nil
                    if key.isUndo { return .undo(toast) }
                    if key.isPlainEscape { return .closeToast }
                    // Any other key passes through and dismisses the toast; ⌘Z is the host's again.
                    dismissedToast = true
                }
            }

            guard let offer = s.current else { return .pass(dismissedToast ? .toastDismissed : .noOffer) }
            // A fill is a write into another app's field; it is taken only by a key known to be
            // headed there. Ghost offers come from the frontmost field, so an unknown target is
            // that field.
            if case .fill = offer.kind, key.targetPID == nil { return .pass(.otherApp) }
            guard key.isHeaded(to: offer.target.pid) else { return .pass(.otherApp) }
            if offer.isExpired(at: now) {
                s.current = nil
                s.typedSinceOffer = ""
                return .pass(.expired)
            }

            if key.isPlainTab {
                let claim = Claim(
                    claimID: s.nextClaimID,
                    offer: offer,
                    typedSinceOffer: s.typedSinceOffer,
                    claimedAt: now
                )
                s.nextClaimID &+= 1
                s.current = nil
                s.typedSinceOffer = ""
                s.insertingClaimID = claim.claimID
                s.consumedTarget = nil
                s.claimCount &+= 1
                s.lastClaim = ClaimRecord(
                    claimID: claim.claimID,
                    offerID: offer.id,
                    claimedAt: now,
                    insertionLength: claim.insertionText.count,
                    outcome: .pending
                )
                return .consume(claim)
            }

            // ⌘1, ⌘2 and ⌘3 choose among visible alternatives or actions. Neither ghost text nor a
            // single fill shows any, so they keep the host's meaning (⌘1 switches browser tabs) and,
            // like every key that passes through, dismiss the offer (Fable plan, section 5,
            // change 6; SURFACES.md section 8).
            if key.commandDigit != nil {
                s.current = nil
                s.typedSinceOffer = ""
                return .pass(.dismissed)
            }

            // Typing the head of ghost text keeps the rest on offer. A fill value is all or nothing:
            // typing into the field removes its ghost (SURFACES.md section 5).
            if case .ghost = offer.kind, let typed = key.text, !typed.isEmpty, !key.command, !key.control {
                let remaining = offer.text.dropFirst(s.typedSinceOffer.count)
                if remaining.hasPrefix(typed), remaining.count > typed.count {
                    s.typedSinceOffer += typed
                    return .pass(.typedThrough)
                }
            }

            s.current = nil
            s.typedSinceOffer = ""
            return .pass(.dismissed)
        }
    }

    // MARK: - Insertion queue

    /// Checks a claim against a fresh read of the field. A rejection ends the claim; nothing is
    /// inserted.
    public func confirm(
        _ claim: Claim,
        live: InsertionGuard.LiveField,
        now: Date = Date()
    ) -> Result<InsertionGuard.ApprovedEdit, InsertionGuard.Rejection> {
        let result: Result<InsertionGuard.ApprovedEdit, InsertionGuard.Rejection>
        if let edit = claim.edit() {
            result = InsertionGuard.approve(
                edit: edit,
                live: live,
                createdAt: claim.offer.createdAt,
                now: now,
                maxAgeSeconds: claim.offer.maxAgeSeconds
            )
        } else {
            result = .failure(.rangeSplitsCharacter(start: claim.offer.caretUTF16, end: claim.offer.caretUTF16))
        }
        state.withLock { s in
            switch result {
            case .success:
                s.consumedTarget = live.target
                Self.setOutcome(.approved, claimID: claim.claimID, in: &s)
            case .failure(let rejection):
                Self.setOutcome(.rejected(rejection.code), claimID: claim.claimID, in: &s)
                if s.insertingClaimID == claim.claimID { s.insertingClaimID = nil }
            }
        }
        return result
    }

    /// Ends a claim that was refused before the guard ran (the target app is no longer allowed,
    /// the field cannot be read, a fill's source is gone). Nothing was written.
    public func abandon(claimID: UInt64, reason: String) {
        state.withLock { s in
            Self.setOutcome(.rejected(reason), claimID: claimID, in: &s)
            if s.insertingClaimID == claimID { s.insertingClaimID = nil }
        }
    }

    /// Ends an approved claim. Offers are accepted again afterwards, except for the revision the
    /// insertion consumed.
    public func finishInsertion(claimID: UInt64, error: String?) {
        state.withLock { s in
            Self.setOutcome(error.map(ClaimOutcome.insertFailed) ?? .inserted, claimID: claimID, in: &s)
            if s.insertingClaimID == claimID { s.insertingClaimID = nil }
        }
    }

    // MARK: - Inspection

    public func snapshot() -> Snapshot {
        state.withLock { s in
            Snapshot(
                current: s.current,
                typedSinceOffer: s.typedSinceOffer,
                lastClaim: s.lastClaim,
                insertingClaimID: s.insertingClaimID,
                toast: s.toast,
                publishedCount: s.publishedCount,
                claimCount: s.claimCount,
                refusedPublishCount: s.refusedPublishCount
            )
        }
    }

    private static func setOutcome(_ outcome: ClaimOutcome, claimID: UInt64, in s: inout State) {
        guard s.lastClaim?.claimID == claimID else { return }
        s.lastClaim?.outcome = outcome
    }
}
