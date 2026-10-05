import ApplicationServices
import CaretHostCore
import CoreGraphics
import Foundation
import os

/// Host state that more than one thread reads: the main thread writes it, the debug socket and the
/// insertion queue read it, the tap thread stamps key-downs. One unfair lock, short sections.
final class HostStatus: @unchecked Sendable {
    struct Fields {
        var engine = DebugState.Engine(state: "loading")
        var focus: DebugState.Focus?
        var presentation: String?
        var lastInsertion: DebugState.Insertion?
        var lastUndo: DebugState.UndoInfo?
        var fill = DebugState.FillStatus()
        var surface: DebugState.SurfaceInfo?
        var counters: [String: UInt64] = [:]
        /// The ghost overlay's recent attempts, oldest first, at most `GhostFit.keptRecords`.
        var ghostFits: [GhostFit.Record] = []
        /// The last ghost held for cover, with the covering window.
        var ghostHold: DebugState.LineHidden?
        var writing: DebugState.WritingInfo?
        var pageSight: PageSight.DebugInfo?
        var routing: DebugState.RoutingInfo?
    }

    struct KeyStamp: Equatable {
        var sequence: UInt64
        var uptimeNanos: UInt64
    }

    let latency = LatencyRecorder()
    /// `latency` for the key that finished a sentence or paragraph: the router's breakpoint (H6).
    let breakpointLatency = LatencyRecorder()
    /// Fill proposal received, to the offer for it published.
    let proposalToOffer = LatencyRecorder()
    /// A focus notification in a form's app, to the fill offer for the newly focused field.
    let focusToOffer = LatencyRecorder()
    let startedAt = Date()
    private let fields = OSAllocatedUnfairLock(initialState: Fields())
    private let lastKey = OSAllocatedUnfairLock(initialState: KeyStamp(sequence: 0, uptimeNanos: 0))
    private let clicks = OSAllocatedUnfairLock(initialState: UInt64(0))

    func update(_ body: (inout Fields) -> Void) {
        fields.withLock { body(&$0) }
    }

    func read() -> Fields {
        fields.withLock { $0 }
    }

    func increment(_ counter: String) {
        fields.withLock { $0.counters[counter, default: 0] &+= 1 }
    }

    /// Tap thread: one user key-down at `uptimeNanos`.
    func noteKeyDown(_ uptimeNanos: UInt64) {
        lastKey.withLock { stamp in
            stamp.sequence &+= 1
            stamp.uptimeNanos = uptimeNanos
        }
    }

    func lastKeyDown() -> KeyStamp {
        lastKey.withLock { $0 }
    }

    /// Tap thread: one user mouse-down (Caret's own marked clicks never reach here).
    func noteMouseDown() {
        clicks.withLock { $0 &+= 1 }
    }

    /// The user's key-downs and mouse-downs so far: a later mark that differs means input arrived.
    struct InputMark: Equatable {
        var keys: UInt64
        var clicks: UInt64
    }

    func inputMark() -> InputMark {
        InputMark(keys: lastKeyDown().sequence, clicks: clicks.withLock { $0 })
    }
}

enum TrustProbe {
    static func current(eventTapEnabled: Bool) -> DebugState.Trust {
        DebugState.Trust(
            accessibility: AXIsProcessTrusted(),
            listenEvents: CGPreflightListenEventAccess(),
            postEvents: CGPreflightPostEventAccess(),
            eventTap: eventTapEnabled
        )
    }
}
