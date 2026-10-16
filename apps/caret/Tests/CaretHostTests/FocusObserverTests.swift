import ApplicationServices
import XCTest
@testable import CaretHost

/// PR #47 review (Codex P2): `AXObserverCreate` can fail while an app is still launching. The
/// observer then tried again on the retry schedule only after a creation that succeeded, so a
/// failed one left the app unobserved until the next app switch.
@MainActor
final class FocusObserverTests: XCTestCase {
    /// Not this test process, which `FocusObserver` never observes. No app runs under it.
    let launching: pid_t = 424_242

    func testAFailedObserverCreationIsRetriedWhileTheAppStaysInFront() {
        let launching = self.launching
        var created: [pid_t] = []
        var made: AXObserver?
        var notes: [String] = []
        let retried = expectation(description: "the observer is created again")
        let observer = FocusObserver(
            frontmost: { (pid: launching, bundleURL: nil) },
            createObserver: { pid, callback in
                created.append(pid)
                guard created.count > 1 else { return nil }
                // A real observer, made for this process.
                let real = FocusObserver.systemObserver(ProcessInfo.processInfo.processIdentifier, callback)
                if created.count == 2 {
                    made = real
                    retried.fulfill()
                }
                return real
            }
        )
        observer.onNote = { notes.append($0) }
        observer.start()
        XCTAssertEqual(created, [launching])
        XCTAssertNil(observer.observingPID)
        wait(for: [retried], timeout: FocusObserver.retryDelays[0] + 5)
        // The retry that made it has returned; the next one is a second away.
        XCTAssertNotNil(made, "AXObserverCreate for the test process")
        XCTAssertEqual(observer.observingPID, launching)
        observer.stop()
        XCTAssertEqual(Array(created.prefix(2)), [launching, launching])
        XCTAssertEqual(Array(notes.prefix(2)), ["focus.observe.createFailed", "focus.observe.retry"])
    }

    func testAFailedObserverCreationIsNotRetriedOnceAnotherAppIsInFront() {
        var front: pid_t = launching
        var created: [pid_t] = []
        let retried = expectation(description: "no second creation")
        retried.isInverted = true
        let observer = FocusObserver(
            frontmost: { (pid: front, bundleURL: nil) },
            createObserver: { pid, _ in
                created.append(pid)
                if created.count == 2 { retried.fulfill() }
                return nil
            }
        )
        observer.start()
        front = launching + 1
        wait(for: [retried], timeout: FocusObserver.retryDelays[0] + 0.5)
        observer.stop()
        XCTAssertEqual(created, [launching])
    }
}
