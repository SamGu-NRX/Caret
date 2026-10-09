import CaretHostCore
import Foundation
import os

/// The apps Caret is off in (`CaretSettings.appsOff`, brief item 7), readable from any thread. The settings belong to
/// the main thread, but fills and helper surfaces ask about a target from wherever they decide; HostRuntime copies
/// the list here on launch and on every settings change.
final class AppSwitch: @unchecked Sendable {
    static let shared = AppSwitch()
    private let off = OSAllocatedUnfairLock(initialState: Set<String>())

    func update(_ settings: CaretSettings) {
        off.withLock { $0 = Set(settings.appsOff) }
    }

    func isOff(bundleID: String?) -> Bool {
        guard let bundleID else { return false }
        return off.withLock { $0.contains(bundleID) }
    }

    func isOff(pid: Int32) -> Bool {
        isOff(bundleID: NSRunningApplicationBundle.id(of: pid))
    }
}
