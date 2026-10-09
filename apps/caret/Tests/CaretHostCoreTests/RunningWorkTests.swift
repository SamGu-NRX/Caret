import CaretScreenCore
import Foundation
import XCTest
@testable import CaretHostCore

/// What the login-item hand-off waits for: accepted work runs from its accept to the helper's end for it.
final class RunningWorkTests: XCTestCase {
    private func progress(_ task: String, _ phase: TaskProgress.Phase) -> TaskProgress {
        let reason = phase == .stopped ? #""stopReason":"you","# : ""
        let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"\#(task)","planId":"p","phase":"\#(phase.rawValue)",\#(reason)"step":1,"steps":2,"says":null,"detail":null}"#
        return try! JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
    }

    func testAnAcceptRunsUntilTheHelperEndsIt() {
        var work = RunningWork()
        XCTAssertTrue(work.isEmpty(at: 0))
        work.accepted("fill-1", at: 0)
        XCTAssertFalse(work.isEmpty(at: 1), "Done pressed before the first progress still finds the fill running")
        for phase in [TaskProgress.Phase.started, .acting, .verified, .skipped] {
            work.progress(progress("fill-1", phase))
            XCTAssertFalse(work.isEmpty(at: 1000), "\(phase): once started, it runs however long it takes")
        }
        work.progress(progress("fill-1", .done))
        XCTAssertTrue(work.isEmpty(at: 1000))
    }

    func testAnAcceptThatCouldNotBeWrittenIsNotRunning() {
        var work = RunningWork()
        work.accepted("fill-1", at: 0)
        work.unsent("fill-1")
        XCTAssertTrue(work.isEmpty(at: 0))
    }

    func testAnAnswerReadBeforeTheWriterReturnsStillEndsTheRun() {
        // HelperClient records the accept before writing, so a quick refusal read on the reader thread finds it.
        var work = RunningWork()
        work.accepted("fill-1", at: 0)
        work.progress(progress("fill-1", .stopped))
        XCTAssertTrue(work.isEmpty(at: 0), "not left running for the session")
    }

    func testAnAcceptTheHelperNeverAnswersStopsCountingAfterItsWindow() {
        // A refused goalAccept comes back as an error line, with no progress for its segment.
        var work = RunningWork()
        work.accepted("goal-1:s0", at: 100)
        XCTAssertFalse(work.isEmpty(at: 100 + RunningWork.answerWindow - 1))
        XCTAssertTrue(work.isEmpty(at: 100 + RunningWork.answerWindow), "the login item is not held for the session")
    }

    func testAPageTaskSegmentIsCountedUnderTheHelpersTaskID() {
        let accept = GoalAccept(goalId: "goal-3-r1", segment: 2, digest: "d", at: 1)
        XCTAssertEqual(accept.taskID, "goal-3-r1:s2", "helper/src/goals/runs.ts segmentTaskId")
        var work = RunningWork()
        work.accepted(accept.taskID, at: 0)
        work.progress(progress("goal-3-r1:s2", .done))
        XCTAssertTrue(work.isEmpty(at: 0))
    }

    func testEveryEndingEndsItAndPausedDoesNot() {
        for ending in [TaskProgress.Phase.done, .stopped, .handoff, .undone] {
            var work = RunningWork()
            work.accepted("t", at: 0)
            work.progress(progress("t", .started))
            work.progress(progress("t", ending))
            XCTAssertTrue(work.isEmpty(at: 0), "\(ending)")
        }
        var paused = RunningWork()
        paused.accepted("t", at: 0)
        paused.progress(progress("t", .paused))
        XCTAssertFalse(paused.isEmpty(at: 1000), "a paused run is kept by the helper; a new one would restore it as stopped")
    }

    func testEachRunIsItsOwnAndADroppedHelperEndsThemAll() {
        var work = RunningWork()
        work.accepted("a", at: 0)
        work.progress(progress("b", .started))
        work.progress(progress("a", .done))
        XCTAssertFalse(work.isEmpty(at: 0), "b is still running")
        work.progress(progress("c", .done))
        XCTAssertEqual(work.running, ["b"], "an end for a run never seen changes nothing")
        work.accepted("d", at: 0)
        work.helperGone()
        XCTAssertTrue(work.isEmpty(at: 0))
    }
}
