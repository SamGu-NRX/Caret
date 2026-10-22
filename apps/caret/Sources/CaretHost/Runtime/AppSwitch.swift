import CaretHostCore
import Foundation
import os

/// The apps Caret is off in (`CaretSettings.appsOff`, brief item 7), readable from any thread. The settings belong to
/// the main thread, but fills and helper surfaces ask about a target from wherever they decide; HostRuntime copies
/// the list here on launch and on every settings change.
final class AppSwitch: @unchecked Sendable {
    static let shared = AppSwitch()
    private let off = OSAllocatedUnfairLock(initialState: Set<String>())
    /// Whether writing help is on at all: not paused, the words role on (`HostGate.allowsGhostText`).
    private let writing = OSAllocatedUnfairLock(initialState: false)

    func update(_ settings: CaretSettings) {
        off.withLock { $0 = Set(settings.appsOff) }
        writing.withLock { $0 = HostGate.allowsGhostText(settings) }
    }

    /// Whether the rewrite key is Caret's for a key headed to `pid`: writing help on, and Caret not off in that app.
    /// Otherwise the chord is the app's (PR #16 review). Tap thread.
    func takesRewriteKey(pid: Int32) -> Bool {
        takesRewriteKey(bundleID: NSRunningApplicationBundle.id(of: pid))
    }

    func takesRewriteKey(bundleID: String?) -> Bool {
        writing.withLock { $0 } && !isOff(bundleID: bundleID)
    }

    func isOff(bundleID: String?) -> Bool {
        guard let bundleID else { return false }
        return off.withLock { $0.contains(bundleID) }
    }

    func isOff(pid: Int32) -> Bool {
        isOff(bundleID: NSRunningApplicationBundle.id(of: pid))
    }
}
