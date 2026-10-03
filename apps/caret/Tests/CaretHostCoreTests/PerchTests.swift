import CaretScreenCore
import CoreGraphics
import XCTest
@testable import CaretHostCore

/// A task record as the helper sends it, decoded through the screen track's own Codable so the
/// tests cannot drift from the wire format.
func taskRecord(
    _ id: String, _ state: TaskState, kind: TaskKind = .plan, pid: Int? = 4242, updatedAt: Int64 = 1_000,
    step: Int? = nil, steps: Int? = nil, undoable: Bool = false, title: String? = "Caret Fixture — Executor",
    says: String = "Fill the six fields", cause: TaskCause? = nil, frame: [Double]? = nil
) -> TaskRecord {
    var json: [String: Any] = [
        "id": id, "kind": kind.rawValue, "state": state.rawValue, "cause": cause?.rawValue ?? NSNull(), "says": says,
        "app": pid.map { ["pid": $0, "bundleId": "dev.caret.fixture", "name": "Caret Fixture"] as [String: Any] } ?? NSNull(),
        "windowId": pid.map { "\($0)-1" } ?? NSNull(), "windowTitle": title ?? NSNull(), "frame": frame ?? NSNull(),
        "step": step ?? NSNull(), "steps": steps ?? NSNull(), "stepSays": NSNull(), "remaining": [String](),
        "detail": NSNull(), "undoable": undoable, "startedAt": 500, "updatedAt": updatedAt, "pending": NSNull(),
    ]
    json["id"] = id
    let data = try! JSONSerialization.data(withJSONObject: json)
    return try! JSONDecoder().decode(TaskRecord.self, from: data)
}

func activity(_ seq: Int, _ task: TaskRecord, from: TaskState? = nil) -> Activity {
    let taskJSON = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(task))
    let json: [String: Any] = ["type": "activity", "v": Proto.version, "seq": seq, "at": task.updatedAt, "from": from?.rawValue ?? NSNull(), "task": taskJSON]
    return try! JSONDecoder().decode(Activity.self, from: JSONSerialization.data(withJSONObject: json))
}

func listReply(_ id: String, seq: Int, _ tasks: [TaskRecord], error: String? = nil, truncated: Bool = false) -> ActivityReply {
    let tasksJSON = try! tasks.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
    let json: [String: Any] = [
        "type": "activityReply", "v": Proto.version, "requestId": id, "error": error ?? NSNull(), "seq": seq,
        "tasks": tasksJSON, "events": [Any](), "truncated": truncated,
    ]
    return try! JSONDecoder().decode(ActivityReply.self, from: JSONSerialization.data(withJSONObject: json))
}

private func ms(_ seconds: Double) -> Date { Date(timeIntervalSince1970: seconds) }

// MARK: - The feed

final class ActivityFeedTests: XCTestCase {
    func testMessagesReplaceTheWholeRecord() {
        var feed = ActivityFeed()
        XCTAssertEqual(feed.applyList(listReply("l1", seq: 3, [taskRecord("a", .running, step: 1, steps: 6)])), true)
        XCTAssertEqual(feed.apply(activity(4, taskRecord("a", .running, updatedAt: 2_000, step: 2, steps: 6))), .applied)
        XCTAssertEqual(feed.tasks["a"]?.step, 2)
        XCTAssertEqual(feed.seq, 4)
    }

    func testAnOldMessageAfterAListIsStale() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 5, [taskRecord("a", .done)]))
        XCTAssertEqual(feed.apply(activity(5, taskRecord("a", .running))), .stale)
        XCTAssertEqual(feed.tasks["a"]?.state, .done)
    }

    func testASkippedSequenceNumberIsAGapButStillApplied() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 2, []))
        XCTAssertEqual(feed.apply(activity(5, taskRecord("b", .needsYou))), .gap)
        XCTAssertEqual(feed.tasks["b"]?.state, .needsYou)
        XCTAssertEqual(feed.seq, 5)
    }

    func testBeforeTheFirstListNothingIsAGap() {
        var feed = ActivityFeed()
        XCTAssertEqual(feed.apply(activity(9, taskRecord("a", .running))), .applied)
        // The list arriving after it is newer and replaces everything, including pruned records.
        XCTAssertTrue(feed.applyList(listReply("l1", seq: 12, [taskRecord("c", .done)])))
        XCTAssertEqual(Set(feed.tasks.keys), ["c"])
    }

    func testAnOlderOrFailedListChangesNothing() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 8, [taskRecord("a", .running)]))
        XCTAssertFalse(feed.applyList(listReply("l2", seq: 7, [])))
        XCTAssertFalse(feed.applyList(listReply("l3", seq: 9, [], error: "boom")))
        XCTAssertEqual(Set(feed.tasks.keys), ["a"])
    }

    func testResetForgetsTheSession() {
        var feed = ActivityFeed()
        feed.applyList(listReply("l1", seq: 8, [taskRecord("a", .running)]))
        feed.reset()
        XCTAssertTrue(feed.tasks.isEmpty)
        XCTAssertFalse(feed.listed)
        // A new helper numbers from 1 again.
        XCTAssertEqual(feed.apply(activity(1, taskRecord("z", .running))), .applied)
    }
}

// MARK: - The list's rows and their actions

final class ActivityRowTests: XCTestCase {
    let now = ms(1_790_971_200)
    var t: Int64 { Int64(now.timeIntervalSince1970 * 1000) }

    func testEachStateGoesToItsSectionWithItsButtons() {
        func row(_ r: TaskRecord) -> ActivityRow? { ActivityList.row(for: r) }
        XCTAssertNil(row(taskRecord("ready", .ready)), "a prepared offer is not work")

        let running = row(taskRecord("r", .running, step: 3, steps: 6))!
        XCTAssertEqual(running.section, .inProgress)
        XCTAssertEqual(running.progress, "Step 4 of 6")
        XCTAssertEqual(running.actions, [.takeOver])

        let watch = row(taskRecord("w", .running, kind: .watch))!
        XCTAssertEqual(watch.progress, "Watching")
        XCTAssertEqual(watch.actions, [], "a watch has no run to take over")

        let paused = row(taskRecord("p", .paused, step: 2, steps: 6, undoable: true))!
        XCTAssertEqual(paused.section, .needsYou)
        XCTAssertEqual(paused.progress, "Stopped before step 3 of 6")
        XCTAssertEqual(paused.actions, [.resume, .undo])
        XCTAssertEqual(row(taskRecord("p2", .paused, step: 2, steps: 6))!.actions, [.resume])

        let asks = row(taskRecord("n", .needsYou, kind: .watch))!
        XCTAssertEqual(asks.section, .needsYou)
        XCTAssertEqual(asks.progress, "Waiting for you")
        XCTAssertEqual(asks.actions, [])

        XCTAssertEqual(row(taskRecord("d", .done, undoable: true))!.actions, [.undo])
        XCTAssertEqual(row(taskRecord("d2", .done))!.actions, [], "Undo only where the task is undoable")
        let failed = row(taskRecord("f", .failed, step: 1, steps: 5, undoable: true))!
        XCTAssertEqual(failed.section, .done)
        XCTAssertEqual(failed.progress, "Stopped at step 2 of 5")
        XCTAssertEqual(failed.actions, [.undo])
        XCTAssertEqual(row(taskRecord("u", .undone))!.actions, [], "an undone task has nothing left to undo")
        let partly = row(taskRecord("u2", .undone, undoable: true))!
        XCTAssertEqual(partly.progress, "Partly undone")
        XCTAssertEqual(partly.actions, [.undo], "writes that were not restored can be tried again")
    }

    func testRowActionsSendTheMatchingControl() {
        XCTAssertEqual(RowAction.takeOver.control, .takeOver)
        XCTAssertEqual(RowAction.resume.control, .resume)
        XCTAssertEqual(RowAction.undo.control, .undo)
        XCTAssertEqual(RowAction.resume.label, "Continue")
    }

    func testRowsAreOrderedNeedsYouThenInProgressThenDoneNewestFirst() {
        let rows = ActivityList.rows([
            taskRecord("done-old", .done, updatedAt: t - 9_000),
            taskRecord("run", .running, updatedAt: t - 1_000),
            taskRecord("done-new", .done, updatedAt: t - 2_000),
            taskRecord("needs", .needsYou, updatedAt: t - 50_000),
            taskRecord("paused", .paused, updatedAt: t - 3_000),
        ], now: now)
        XCTAssertEqual(rows.map(\.id), ["paused", "needs", "run", "done-new", "done-old"])
    }

    func testDoneShowsTodayOnlyAndAtMostFive() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        var records = (0..<7).map { taskRecord("d\($0)", .done, updatedAt: t - Int64($0) * 1_000) }
        records.append(taskRecord("yesterday", .done, updatedAt: t - 86_400_000))
        let rows = ActivityList.rows(records, now: now, calendar: calendar)
        XCTAssertEqual(rows.map(\.id), ["d0", "d1", "d2", "d3", "d4"])
    }

    func testNeedsYouCountIncludesPausedRuns() {
        XCTAssertEqual(ActivityList.needsYouCount([taskRecord("a", .paused), taskRecord("b", .needsYou), taskRecord("c", .running)]), 2)
    }
}

// MARK: - The perch's state

final class PerchStateTests: XCTestCase {
    let now = ms(100)

    func testEveryTaskStateMapsToOneMoodOrNone() {
        let expected: [TaskState: Perch.Mood?] = [
            .preparing: .working, .ready: nil, .running: .working, .paused: .waiting,
            .needsYou: .needsYou, .done: .done, .failed: .error, .undone: nil,
        ]
        for state in TaskState.allCases { XCTAssertEqual(Perch.mood(for: state), expected[state]!, state.rawValue) }
    }

    func testTheMostRecentTaskIsTheSubject() {
        let s = Perch.subject([taskRecord("a", .running, updatedAt: 99_000), taskRecord("b", .done, updatedAt: 99_500)], now: now)
        XCTAssertEqual(s?.taskId, "b")
        XCTAssertEqual(s?.mood, .done)
    }

    func testNeedsYouOutranksNewerWork() {
        let s = Perch.subject([
            taskRecord("asks", .needsYou, kind: .watch, pid: 77, updatedAt: 10_000, title: "Caret Fixture — Upload"),
            taskRecord("run", .running, updatedAt: 99_000),
        ], now: now)
        XCTAssertEqual(s?.taskId, "asks")
        XCTAssertEqual(s?.mood, .needsYou)
        XCTAssertEqual(s?.pid, 77)
        XCTAssertEqual(s?.windowTitle, "Caret Fixture — Upload")
        XCTAssertEqual(s?.needsYou, 1)
    }

    func testDoneHoldsBrieflyThenThePerchLeaves() {
        let done = taskRecord("a", .done, updatedAt: 95_000)
        XCTAssertEqual(Perch.subject([done], now: now)?.mood, .done)
        XCTAssertNil(Perch.subject([done], now: ms(95 + Perch.doneHold + 0.01)))
        XCTAssertEqual(Perch.nextExpiry([done], now: now), ms(95 + Perch.doneHold))
    }

    func testAnErrorStaysUntilTheListIsOpened() {
        let failed = taskRecord("f", .failed, updatedAt: 50_000)
        XCTAssertEqual(Perch.subject([failed], now: now)?.mood, .error)
        XCTAssertNil(Perch.subject([failed], now: now, acknowledgedAt: 60_000))
        XCTAssertNil(Perch.nextExpiry([failed], now: now, acknowledgedAt: 60_000))
    }

    func testNothingToReportMeansNoPerch() {
        XCTAssertNil(Perch.subject([], now: now))
        XCTAssertNil(Perch.subject([taskRecord("r", .ready), taskRecord("u", .undone, updatedAt: 99_000)], now: now))
    }
}

// MARK: - Gaze

final class PerchGazeTests: XCTestCase {
    let perch = CGPoint(x: 1400, y: 860)

    func testItLooksTowardTheWindowsCenter() {
        let left = PerchGaze.toward(CGRect(x: 100, y: 800, width: 400, height: 100), from: perch)
        XCTAssertLessThan(left.dx, -0.99)
        XCTAssertEqual(left.dy, 0, accuracy: 0.01)

        let upLeft = PerchGaze.toward(CGRect(x: 200, y: 100, width: 400, height: 300), from: perch)
        XCTAssertLessThan(upLeft.dx, 0)
        XCTAssertLessThan(upLeft.dy, 0, "up is negative y, as in Accessibility frames and the viewBox")

        let above = PerchGaze.toward(CGRect(x: 1300, y: 100, width: 200, height: 200), from: perch)
        XCTAssertEqual(above.dx, 0, accuracy: 0.01)
        XCTAssertEqual(above.dy, -1, accuracy: 0.01)
        XCTAssertEqual(hypot(upLeft.dx, upLeft.dy), 1, accuracy: 0.0001)
    }

    func testAWindowUnderThePerchOrTooCloseGetsAStraightLook() {
        XCTAssertEqual(PerchGaze.toward(CGRect(x: 1000, y: 500, width: 600, height: 600), from: perch), .zero)
        XCTAssertEqual(PerchGaze.toward(CGRect(x: 1410, y: 870, width: 10, height: 10), from: perch), .zero)
        XCTAssertEqual(PerchGaze.toward(.null, from: perch), .zero)
    }

    func testWithoutAWindowWorkingLooksUpAndOut() {
        XCTAssertEqual(PerchGaze.fallback(for: .working), CGVector(dx: 0.7, dy: -0.7))
        XCTAssertEqual(PerchGaze.fallback(for: .needsYou), .zero)
    }
}

// MARK: - Yielding to the field and the caret

final class PerchPlacementTests: XCTestCase {
    let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
    let size = CGSize(width: 56, height: 48)

    func testHomesSitInTheCornersOfTheVisibleFrame() {
        let f = PerchPlacement.frame(.bottomRight, size: size, in: visible)
        XCTAssertEqual(f, CGRect(x: 1440 - 10 - 56, y: 875 - 10 - 48, width: 56, height: 48))
        XCTAssertEqual(PerchPlacement.frame(.topLeft, size: size, in: visible).origin, CGPoint(x: 10, y: 35))
    }

    func testWithNothingFocusedItSitsBottomRight() {
        let c = PerchPlacement.choose(visible: visible, size: size, field: nil, caret: nil, current: nil)
        XCTAssertEqual(c.home, .bottomRight)
        XCTAssertFalse(c.overlapsField || c.overlapsCaret)
    }

    func testAFieldNearTheCornerMovesItAside() {
        let field = CGRect(x: 1100, y: 800, width: 300, height: 22)
        let caret = CGRect(x: 1390, y: 802, width: 1, height: 17)
        let c = PerchPlacement.choose(visible: visible, size: size, field: field, caret: caret, current: .bottomRight)
        XCTAssertEqual(c.home, .topRight)
        XCTAssertFalse(c.frame.insetBy(dx: -PerchPlacement.clearance, dy: -PerchPlacement.clearance).intersects(field))
    }

    func testItStaysPutWhileItsHomeIsClear() {
        // Top right was chosen earlier; the field moved to the middle, where bottom right is also
        // clear. No jump back.
        let field = CGRect(x: 500, y: 400, width: 300, height: 22)
        let c = PerchPlacement.choose(visible: visible, size: size, field: field, caret: nil, current: .topRight)
        XCTAssertEqual(c.home, .topRight)
    }

    func testAFieldCoveringTheScreenStillLeavesTheCaretClear() {
        let field = visible
        let caret = CGRect(x: 1380, y: 840, width: 1, height: 17)
        let c = PerchPlacement.choose(visible: visible, size: size, field: field, caret: caret, current: .bottomRight)
        XCTAssertNotEqual(c.home, .bottomRight)
        XCTAssertTrue(c.overlapsField)
        XCTAssertFalse(c.overlapsCaret)
    }

    func testTheCaretNearEveryCornerSendsItToTheFarthest() {
        // A tiny visible frame: every home is within clearance of the caret.
        let tiny = CGRect(x: 0, y: 0, width: 120, height: 100)
        let caret = CGRect(x: 40, y: 40, width: 1, height: 16)
        let c = PerchPlacement.choose(visible: tiny, size: size, field: nil, caret: caret, current: .topLeft)
        XCTAssertEqual(c.home, .bottomRight)
        XCTAssertTrue(c.overlapsCaret)
    }
}

// MARK: - Real input pauses a run

final class InputPauseTests: XCTestCase {
    func testAKeyInTheRunsAppPausesItOnce() {
        var pause = InputPause()
        pause.update([taskRecord("run", .running, pid: 4242)], ownPID: 1)
        XCTAssertEqual(pause.input(pid: 4242), ["run"])
        XCTAssertEqual(pause.input(pid: 4242), [], "one pause per stretch of running")
        // The helper paused it; Continue resumes it; the next real key pauses it again.
        pause.update([taskRecord("run", .paused, pid: 4242)], ownPID: 1)
        XCTAssertTrue(pause.isEmpty)
        pause.update([taskRecord("run", .running, pid: 4242)], ownPID: 1)
        XCTAssertEqual(pause.input(pid: 4242), ["run"])
    }

    func testInputElsewhereOrInAWatchedWindowPausesNothing() {
        var pause = InputPause()
        pause.update([
            taskRecord("run", .running, pid: 4242),
            taskRecord("watch", .running, kind: .watch, pid: 5555),
            taskRecord("nowhere", .running, pid: nil),
            taskRecord("asks", .needsYou, pid: 6666),
        ], ownPID: 1)
        XCTAssertEqual(pause.input(pid: 9999), [])
        XCTAssertEqual(pause.input(pid: 5555), [], "the user's own input in a watched window is expected")
        XCTAssertEqual(pause.input(pid: 6666), [])
        XCTAssertEqual(pause.running.keys.sorted(), [4242])
    }

    func testInputInCaretItselfNeverPauses() {
        var pause = InputPause()
        pause.update([taskRecord("run", .running, pid: 77)], ownPID: 77)
        XCTAssertTrue(pause.isEmpty)
    }

    func testEveryRunInTheAppPauses() {
        var pause = InputPause()
        pause.update([taskRecord("b", .running, pid: 4242), taskRecord("a", .running, pid: 4242)], ownPID: 1)
        XCTAssertEqual(pause.input(pid: 4242), ["a", "b"])
    }
}
