import AppKit
import CaretHostCore

/// Says `sessionLocked` when the user locks the screen, switches to another user, or logs out, restarts or shuts
/// down. The centers are parameters so a test can post to its own; the defaults are the system's.
final class SessionLockWatch {
    private let observers: [(NotificationCenter, NSObjectProtocol)]

    init(workspace: NotificationCenter = NSWorkspace.shared.notificationCenter,
         distributed: NotificationCenter = DistributedNotificationCenter.default(),
         send: @escaping @Sendable (SessionLocked.Why) -> Void) {
        let watched: [(NotificationCenter, Notification.Name, SessionLocked.Why)] = [
            (distributed, Notification.Name("com.apple.screenIsLocked"), .lock),
            // Fast user switching: the session keeps running behind another user's. A switch may post the screen lock
            // too (not checked here: it needs a real session switch), which only clears the cache twice.
            (workspace, NSWorkspace.sessionDidResignActiveNotification, .lock),
            // Logging out, restarting and shutting down all post this before apps are asked to quit.
            (workspace, NSWorkspace.willPowerOffNotification, .signOut),
        ]
        observers = watched.map { center, name, why in
            (center, center.addObserver(forName: name, object: nil, queue: nil) { _ in send(why) })
        }
    }

    deinit {
        for (center, observer) in observers { center.removeObserver(observer) }
    }
}
