import ApplicationServices
import Foundation

/// Accessibility notifications from the apps that hold a fill proposal's form, whether or not they
/// are frontmost.
///
/// The ghost-text `FocusObserver` follows the frontmost app only. A fill offer has to go away the
/// moment focus leaves its field or text appears in it, so that a Tab after that passes through;
/// this watches each form app's focus and value changes and reports them, coalesced, to `onChange`.
@MainActor
final class FillTargetWatcher {
    var onChange: ((pid_t, UInt64) -> Void)?

    private var observers: [pid_t: AXObserver] = [:]
    private var pending: [pid_t: UInt64] = [:]
    private let coalesceInterval: TimeInterval = 0.008

    private static let notifications = [
        kAXFocusedUIElementChangedNotification,
        kAXFocusedWindowChangedNotification,
        kAXValueChangedNotification,
        kAXSelectedTextChangedNotification,
        kAXWindowMovedNotification,
        kAXWindowResizedNotification,
        kAXUIElementDestroyedNotification,
    ]

    func watch(_ pid: pid_t) {
        guard observers[pid] == nil else { return }
        var created: AXObserver?
        guard AXObserverCreate(pid, Self.callback, &created) == .success, let created else { return }
        let app = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in Self.notifications {
            AXObserverAddNotification(created, app, name as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observers[pid] = created
    }

    func unwatch(_ pid: pid_t) {
        guard let observer = observers.removeValue(forKey: pid) else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }

    func stop() {
        for pid in Array(observers.keys) { unwatch(pid) }
    }

    var watched: [pid_t] { Array(observers.keys) }

    private static let callback: AXObserverCallback = { _, element, _, refcon in
        guard let refcon else { return }
        let watcher = Unmanaged<FillTargetWatcher>.fromOpaque(refcon).takeUnretainedValue()
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return }
        MainActor.assumeIsolated { watcher.schedule(pid) }
    }

    private func schedule(_ pid: pid_t) {
        guard pending[pid] == nil else { return }
        pending[pid] = DispatchTime.now().uptimeNanoseconds
        DispatchQueue.main.asyncAfter(deadline: .now() + coalesceInterval) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let at = self.pending.removeValue(forKey: pid) else { return }
                self.onChange?(pid, at)
            }
        }
    }
}
