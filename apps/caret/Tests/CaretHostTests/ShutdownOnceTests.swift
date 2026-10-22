import XCTest
@testable import CaretHost

/// Quit must always quit: every caller of the shutdown gets an answer by the deadline, even when a shutdown started
/// elsewhere (the hand-off to the login item) never finishes.
@MainActor
final class ShutdownOnceTests: XCTestCase {
    /// A shutdown that outlasts every deadline here, as the hand-off did in beta.2's VM run.
    private func stuck() async {
        try? await Task.sleep(nanoseconds: 30_000_000_000)
    }

    func testQuitWhileAStuckShutdownIsInFlightStillReplies() async {
        let shutdown = ShutdownOnce()
        XCTAssertTrue(shutdown.start { await self.stuck() })
        var replies: [Bool] = []
        var ranQuitBody = false
        let started = Date()
        shutdown.finish(deadline: 0.3, body: { ranQuitBody = true }) { replies.append($0) }
        while replies.isEmpty, Date().timeIntervalSince(started) < 3 { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(replies, [false], "Quit got no reply, or more than one")
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertFalse(ranQuitBody, "a second shutdown ran alongside the first")
    }

    func testQuitRepliesWhenItsShutdownFinishes() async {
        let shutdown = ShutdownOnce()
        var stopped = false
        var replies: [Bool] = []
        shutdown.finish(deadline: 5, body: { stopped = true }) { replies.append($0) }
        let started = Date()
        while replies.isEmpty, Date().timeIntervalSince(started) < 3 { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(stopped)
        XCTAssertEqual(replies, [true])
        XCTAssertLessThan(Date().timeIntervalSince(started), 1, "replied at the deadline, not when the shutdown finished")
    }

    func testTheShutdownRunsOnce() async {
        let shutdown = ShutdownOnce()
        var runs = 0
        XCTAssertFalse(shutdown.started)
        XCTAssertTrue(shutdown.start { runs += 1 })
        XCTAssertFalse(shutdown.start { runs += 1 })
        XCTAssertTrue(shutdown.started)
        let finished = await shutdown.wait(deadline: 2)
        XCTAssertTrue(finished)
        XCTAssertEqual(runs, 1)
    }

    func testWaitingWithNoShutdownReturnsAtOnce() async {
        let finished = await ShutdownOnce().wait(deadline: 5)
        XCTAssertTrue(finished)
    }
}
