import CaretScreenCore
import CoreGraphics
import XCTest
@testable import CaretHostCore

/// B8's changes to what the activity side reads: work done by the user's own hand, the task
/// window's frame, and a list reply cut at the helper's size cap.
final class ActivityProtocolTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_100)
    private var nowMs: Int64 { Int64(now.timeIntervalSince1970 * 1000) }

    // MARK: - Done by hand

    func testALoopFinishTypedByHandGetsNoGestureAndNoRow() {
        let byHand = taskRecord("offer-2", .done, kind: .loopFinish, updatedAt: nowMs - 1_000, cause: .you)
        XCTAssertNil(Perch.subject([byHand], now: now), "no gesture of relief for work Caret did not do")
        XCTAssertNil(ActivityList.row(for: byHand))
        let routine = taskRecord("r-1", .done, kind: .routine, updatedAt: nowMs - 1_000, cause: .you)
        XCTAssertNil(ActivityList.row(for: routine))
    }

    func testWorkCaretDidStillCelebratesAndLists() {
        let ran = taskRecord("offer-2", .done, kind: .loopFinish, updatedAt: nowMs - 1_000, cause: .caret)
        XCTAssertEqual(Perch.subject([ran], now: now)?.mood, .done)
        XCTAssertEqual(ActivityList.row(for: ran)?.section, .done)
    }

    func testAWatchTheUserClosedListsButDoesNotCelebrate() {
        let closed = taskRecord("w-1", .done, kind: .watch, updatedAt: nowMs - 1_000, cause: .you)
        XCTAssertNil(Perch.subject([closed], now: now))
        XCTAssertEqual(ActivityList.row(for: closed)?.section, .done, "the watch ended; the list says so")
    }

    // MARK: - The task's window

    func testTheSubjectCarriesTheRecordsFrame() {
        let r = taskRecord("run", .running, updatedAt: nowMs, frame: [640, 120, 520, 380])
        XCTAssertEqual(Perch.subject([r], now: now)?.windowFrame, CGRect(x: 640, y: 120, width: 520, height: 380))
        XCTAssertNil(Perch.subject([taskRecord("run", .running, updatedAt: nowMs)], now: now)?.windowFrame)
    }

    func testTheWindowIsFoundByFrameFirstThenByTitle() {
        let a = TaskWindow.Candidate(frame: CGRect(x: 40, y: 60, width: 520, height: 420), title: "Claim form")
        let b = TaskWindow.Candidate(frame: CGRect(x: 640, y: 120, width: 520, height: 380), title: "Claim form")
        let c = TaskWindow.Candidate(frame: CGRect(x: 0, y: 0, width: 300, height: 200), title: "Upload")
        let recorded = CGRect(x: 640.4, y: 119.6, width: 520, height: 380)
        XCTAssertEqual(TaskWindow.pick(frame: recorded, title: "Claim form", among: [a, b, c]), 1, "two windows share the title; the frame tells them apart")
        XCTAssertEqual(TaskWindow.pick(frame: recorded, title: "Upload", among: [a, b, c]), 1, "the frame wins over a title that changed")
        XCTAssertEqual(TaskWindow.pick(frame: CGRect(x: 9, y: 9, width: 9, height: 9), title: "Upload", among: [a, b, c]), 2, "the window moved: the title")
        XCTAssertEqual(TaskWindow.pick(frame: nil, title: "Upload", among: [a, b, c]), 2)
        XCTAssertNil(TaskWindow.pick(frame: nil, title: "Nowhere", among: [a, b, c]), "the caller falls back to the main window")
        XCTAssertNil(TaskWindow.pick(frame: nil, title: "", among: [TaskWindow.Candidate(frame: nil, title: "")]))
        let twin = TaskWindow.Candidate(frame: b.frame, title: "Claim form (2)")
        XCTAssertEqual(TaskWindow.pick(frame: recorded, title: "Claim form (2)", among: [b, twin]), 1, "a shared frame: the title breaks the tie")
        XCTAssertEqual(TaskWindow.pick(frame: recorded, title: "Neither", among: [b, twin]), 0, "a shared frame, no title: the first")
    }

    // MARK: - A capped reply

    func testATruncatedListKeepsTheOlderRecordsItLeftOut() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 3, [taskRecord("old", .done, updatedAt: 100), taskRecord("new", .running, updatedAt: 900)]))
        XCTAssertFalse(feed.incomplete)
        // The capped reply carries only the newest record; "old" is older than all it carries.
        feed.applyList(listReply("l2", seq: 5, [taskRecord("new", .running, updatedAt: 950)], truncated: true))
        XCTAssertTrue(feed.incomplete)
        XCTAssertEqual(Set(feed.tasks.keys), ["old", "new"])
        XCTAssertEqual(feed.tasks["new"]?.updatedAt, 950)
    }

    func testATruncatedListDropsWhatItShouldHaveCarried() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 3, [taskRecord("gone", .running, updatedAt: 990), taskRecord("kept", .running, updatedAt: 900)]))
        // "gone" is newer than the oldest record the reply carries, so the cap did not leave it out: it is gone.
        feed.applyList(listReply("l2", seq: 5, [taskRecord("kept", .running, updatedAt: 900)], truncated: true))
        XCTAssertEqual(Set(feed.tasks.keys), ["kept"])
    }

    func testACompleteListClearsTheFlagAndReplacesEverything() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 3, [taskRecord("old", .done, updatedAt: 100)], truncated: true))
        feed.applyList(listReply("l2", seq: 4, [taskRecord("new", .running, updatedAt: 900)]))
        XCTAssertFalse(feed.incomplete)
        XCTAssertEqual(Set(feed.tasks.keys), ["new"])
        feed.applyList(listReply("l3", seq: 5, [], truncated: true))
        feed.reset()
        XCTAssertFalse(feed.incomplete)
    }

    func testDoneRowsPageFiveAtATimeBehindAndNMore() {
        let records = (0..<12).map { taskRecord("d\($0)", .done, updatedAt: nowMs - Int64($0) * 1_000) }
            + [taskRecord("p", .paused, updatedAt: nowMs - 99_000, steps: 3)]
        let first = ActivityList.page(records, now: now)
        XCTAssertEqual(first.rows.filter { $0.section == .done }.map(\.id), ["d0", "d1", "d2", "d3", "d4"])
        XCTAssertEqual(first.more, 7)
        XCTAssertEqual(first.rows.first?.id, "p", "Needs you is never paged away")
        let second = ActivityList.page(records, now: now, pages: 2)
        XCTAssertEqual(second.rows.filter { $0.section == .done }.count, 10)
        XCTAssertEqual(second.more, 2)
        XCTAssertEqual(ActivityList.page(records, now: now, pages: 3).more, 0)
        XCTAssertEqual(ActivityList.rows(records, now: now), first.rows, "the unpaged rows are the first page")
    }
}
