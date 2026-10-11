import Foundation
import os

/// The host's live permission to change another app (S1 audit #2). Tab, or ⌘Z on a toast, takes a
/// grant; every host mutation (the insertion itself, a selection change before it, the repair of a
/// write that landed in the wrong place, the Tab that advances a form, and an undo) asks
/// `isLive` immediately before it acts, not once at the key.
///
/// `revokeAll` ends every grant taken before it, at once: Caret paused, a run's input pause, Esc on
/// working, a take over, and the helper's connection closing all call it. A grant taken after a
/// revoke is live again. Thread-safe: grants are taken on the tap thread or the debug socket,
/// checked on the insertion queue, and revoked from main.
///
/// An AX call or a posted event already handed to the system cannot be recalled: the boundary is
/// the last check before each call.
public final class HostAuthority: @unchecked Sendable {
    public struct Grant: Equatable, Sendable {
        let epoch: UInt64
        public let id: UInt64
    }

    private struct State {
        var epoch: UInt64 = 0
        var nextID: UInt64 = 0
        /// Why the last revoke happened, and how many there were, for the debug state.
        var lastReason: String?
        var revokes = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    public init() {}

    public func grant() -> Grant {
        state.withLock { s in
            s.nextID &+= 1
            return Grant(epoch: s.epoch, id: s.nextID)
        }
    }

    public func isLive(_ grant: Grant) -> Bool {
        state.withLock { $0.epoch == grant.epoch }
    }

    /// Ends every grant taken so far.
    public func revokeAll(_ reason: String) {
        state.withLock { s in
            s.epoch &+= 1
            s.lastReason = reason
            s.revokes += 1
        }
    }

    public var debugInfo: (revokes: Int, lastReason: String?) {
        state.withLock { ($0.revokes, $0.lastReason) }
    }
}
