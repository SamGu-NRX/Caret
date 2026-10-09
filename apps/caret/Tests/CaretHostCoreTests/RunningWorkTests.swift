import CaretScreenCore
import Foundation
import XCTest
@testable import CaretHostCore

/// What the login-item hand-off waits for: an accepted offer runs from its accept to the helper's end for it.
final class RunningWorkTests: XCTestCase {
    private func progress(_ task: String, _ phase: TaskProgress.Phase) -> TaskProgress {
        let reason = phase == .stopped ? #""stopReason":"you","# : ""
        let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"\#(task)","planId":"p","phase":"\#(phase.rawValue)",\#(reason)"step":1,"steps":2,"says":null,"detail":null}"#
        return try! JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
    }

    func testAnAcceptRunsUntilTheHelperEndsIt() {
        var work = RunningWork()
        XCTAssertTrue(work.isEmpty)
        work.accepted("fill-1")
        XCTAssertFalse(work.isEmpty, "Done pressed before the first progress still finds the fill running")
        for phase in [TaskProgress.Phase.started, .acting, .verified, .skipped] {
            work.progress(progress("fill-1", phase))
            XCTAssertFalse(work.isEmpty, "\(phase)")
        }
        work.progress(progress("fill-1", .done))
        XCTAssertTrue(work.isEmpty)
    }

    func testAnAcceptThatCouldNotBeWrittenIsNotRunning() {
        var work = RunningWork()
        work.accepted("fill-1")
        work.unsent("fill-1")
        XCTAssertTrue(work.isEmpty)
    }

    func testAnAnswerReadBeforeTheWriterReturnsStillEndsTheRun() {
        // HelperClient records the accept before writing, so a quick refusal read on the reader thread finds it.
        var work = RunningWork()
        work.accepted("fill-1")
        work.progress(progress("fill-1", .stopped))
        XCTAssertTrue(work.isEmpty, "not left running for the session")
    }

    func testEveryEndingEndsItAndPausedDoesNot() {
        for ending in [TaskProgress.Phase.done, .stopped, .handoff, .undone] {
            var work = RunningWork()
            work.accepted("t")
            work.progress(progress("t", ending))
            XCTAssertTrue(work.isEmpty, "\(ending)")
        }
        var paused = RunningWork()
        paused.accepted("t")
        paused.progress(progress("t", .paused))
        XCTAssertFalse(paused.isEmpty, "a paused run is kept by the helper; a new one would restore it as stopped")
    }

    func testEachRunIsItsOwnAndADroppedHelperEndsThemAll() {
        var work = RunningWork()
        work.accepted("a")
        work.progress(progress("b", .started))
        work.progress(progress("a", .done))
        XCTAssertFalse(work.isEmpty, "b is still running")
        work.progress(progress("c", .done))
        XCTAssertEqual(work.offers, ["b"], "an end for a run never seen changes nothing")
        work.helperGone()
        XCTAssertTrue(work.isEmpty)
    }
}
