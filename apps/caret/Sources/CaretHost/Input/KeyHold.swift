import AutocompleteCore
import CaretHostCore
import CoreGraphics
import Foundation
import os

/// Holds the keys typed into one app while Caret writes a writing fix there, and sends them on
/// afterwards, in order (`KeyHoldQueue`). The tap starts it when Tab claims a fix, before the Tab
/// returns, so no key typed after Tab reaches the app while its word is selected; the executor
/// ends it when the fix is written or refused.
///
/// Held keys are sent to the same pid, marked as Caret's so the tap lets them through, each
/// followed by its key-up (the tap sees only key-downs, so the original key-up went on already).
final class KeyHold: @unchecked Sendable {
    private let state = OSAllocatedUnfairLock(uncheckedState: KeyHoldQueue<CGEvent>())

    /// Tap thread, inside the Tab's callback.
    func begin(pid: Int32) {
        let now = DispatchTime.now().uptimeNanoseconds
        // Sent under the lock: a key the tap takes after this cannot overtake them.
        state.withLockUnchecked { queue in
            let earlier = queue.pid
            Self.send(queue.begin(pid: pid, now: now), to: earlier ?? pid)
        }
    }

    /// Tap thread, for each user key-down. True when the key is held and must not go on now.
    func take(_ event: CGEvent, pid: Int32?) -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        return state.withLockUnchecked { queue in
            let heldFor = queue.pid
            switch queue.take(event.copy() ?? event, pid: pid, now: now) {
            case .hold: return true
            case .pass(let first):
                if let heldFor { Self.send(first, to: heldFor) }
                return false
            }
        }
    }

    /// Insertion queue, when the fix for `pid` is done. Sends what was held.
    func end(pid: Int32) {
        state.withLockUnchecked { queue in
            guard queue.pid == pid else { return }
            Self.send(queue.end(), to: pid)
        }
    }

    private static func send(_ events: [CGEvent], to pid: Int32) {
        for down in events {
            down.setIntegerValueField(.eventSourceUserData, value: SynthesizedEventMarker.userData)
            down.postToPid(pid)
            if let up = down.copy() {
                up.type = .keyUp
                up.postToPid(pid)
            }
        }
    }
}
