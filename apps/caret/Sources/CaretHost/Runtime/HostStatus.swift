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
        var counters: [String: UInt64] = [:]
    }

    struct KeyStamp: Equatable {
        var sequence: UInt64
        var uptimeNanos: UInt64
    }

    let latency = LatencyRecorder()
    /// Fill proposal received, to the offer for it published.
    let proposalToOffer = LatencyRecorder()
    /// A focus notification in a form's app, to the fill offer for the newly focused field.
    let focusToOffer = LatencyRecorder()
    let startedAt = Date()
    private let fields = OSAllocatedUnfairLock(initialState: Fields())
    private let lastKey = OSAllocatedUnfairLock(initialState: KeyStamp(sequence: 0, uptimeNanos: 0))

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
