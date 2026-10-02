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
    }

    public enum Decision: Equatable, Sendable {
        /// Swallow the key and insert this claim.
        case consume(Claim)
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
        /// The field revision the last insertion started from. An offer for that revision is stale
        /// by construction once the insertion lands.
        var consumedRevision: String?
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
            guard s.insertingClaimID == nil, offer.target.elementRevision != s.consumedRevision else {
                s.refusedPublishCount &+= 1
                return nil
            }
            // The field has moved past the consumed revision; returning to it later is a new state.
            s.consumedRevision = nil
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

    // MARK: - Tap thread

    /// Decides one key-down. Constant time apart from a prefix check on the offer text.
    public func handleKeyDown(_ key: KeyStroke, now: Date = Date()) -> Decision {
        state.withLock { s in
            guard let offer = s.current else { return .pass(.noOffer) }
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
                s.consumedRevision = nil
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

            if let typed = key.text, !typed.isEmpty, !key.command, !key.control {
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
                s.consumedRevision = live.target.elementRevision
                Self.setOutcome(.approved, claimID: claim.claimID, in: &s)
            case .failure(let rejection):
                Self.setOutcome(.rejected(rejection.code), claimID: claim.claimID, in: &s)
                if s.insertingClaimID == claim.claimID { s.insertingClaimID = nil }
            }
        }
        return result
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
