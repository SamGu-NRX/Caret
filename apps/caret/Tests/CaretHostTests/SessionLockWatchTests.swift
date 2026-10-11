import AppKit
import CaretHostCore
import os
import XCTest
@testable import CaretHost

/// Each system notification the watch reads becomes one `sessionLocked` reason. Posted to the test's own centers: a
/// post to the distributed center would tell every app on this Mac that the screen locked.
final class SessionLockWatchTests: XCTestCase {
    func testEachNotificationSaysItsReason() {
        let workspace = NotificationCenter()
        let distributed = NotificationCenter()
        let said = OSAllocatedUnfairLock<[SessionLocked.Why]>(initialState: [])
        do {
            let watch = SessionLockWatch(workspace: workspace, distributed: distributed) { why in said.withLock { $0.append(why) } }
            distributed.post(name: Notification.Name("com.apple.screenIsLocked"), object: nil)
            workspace.post(name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
            workspace.post(name: NSWorkspace.willPowerOffNotification, object: nil)
            workspace.post(name: NSWorkspace.didActivateApplicationNotification, object: nil)
            withExtendedLifetime(watch) {}
        }
        XCTAssertEqual(said.withLock { $0 }, [.lock, .lock, .signOut])
        workspace.post(name: NSWorkspace.willPowerOffNotification, object: nil)
        XCTAssertEqual(said.withLock { $0 }.count, 3, "a released watch says nothing")
    }
}
