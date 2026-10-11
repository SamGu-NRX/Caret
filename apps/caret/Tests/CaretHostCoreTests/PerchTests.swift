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
        // Pinned: in UTC+4 `now` is local midnight, and Done today would hold neither done row
        // (CodeRabbit on PR #10).
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let rows = ActivityList.rows([
            taskRecord("done-old", .done, updatedAt: t - 9_000),
            taskRecord("run", .running, updatedAt: t - 1_000),
            taskRecord("done-new", .done, updatedAt: t - 2_000),
            taskRecord("needs", .needsYou, updatedAt: t - 50_000),
            taskRecord("paused", .paused, updatedAt: t - 3_000),
        ], now: now, calendar: calendar)
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

// MARK: - Working in another window (H3)

final class RimTests: XCTestCase {
    let own: Int32 = 99
    let tracker = CGRect(x: 100, y: 120, width: 600, height: 400)

    func window(_ number: Int, _ pid: Int32, _ bounds: CGRect, layer: Int = 0, alpha: Double = 1) -> Rim.Window {
        Rim.Window(number: number, pid: pid, bounds: bounds, layer: layer, alpha: alpha)
    }

    func testAnUncoveredWindowIsClearAndMatchedByItsFrame() {
        let windows = [window(1, 7, CGRect(x: 800, y: 100, width: 300, height: 300)), window(2, 5, tracker)]
        XCTAssertEqual(Rim.seen(pid: 5, number: nil, frame: tracker.offsetBy(dx: 2, dy: -3), windows: windows, ownPID: own), .clear(number: 2, frame: tracker))
    }

    /// H3: another app's window over any part of it means no rim, which would be drawn over that window.
    func testAWindowInFrontThatOverlapsCoversIt() {
        let mail = CGRect(x: 600, y: 300, width: 400, height: 300)
        let windows = [window(1, 7, mail), window(2, 5, tracker)]
        XCTAssertEqual(Rim.seen(pid: 5, number: 2, frame: nil, windows: windows, ownPID: own), .covered(number: 2, frame: tracker, by: 7))
    }

    /// Caret's own panels, menus and the Dock above layer 0, and tiny windows never count as cover.
    func testCaretsOwnPanelsMenusAndTinyWindowsDoNotCover() {
        let windows = [
            window(1, own, tracker.insetBy(dx: 50, dy: 50)),
            window(2, 3, CGRect(x: 0, y: 450, width: 1440, height: 90), layer: 20),
            window(3, 7, CGRect(x: 300, y: 300, width: 30, height: 30)),
            window(4, 8, tracker, alpha: 0),
            window(5, 5, tracker),
        ]
        XCTAssertTrue(Rim.seen(pid: 5, number: nil, frame: tracker, windows: windows, ownPID: own).isClear)
    }

    /// Once matched by number it follows the window as it moves, which a frame match could not.
    func testANumberedWindowIsFollowedWhereverItMoved() {
        let moved = tracker.offsetBy(dx: 240, dy: 60)
        XCTAssertEqual(Rim.seen(pid: 5, number: 2, frame: tracker, windows: [window(2, 5, moved)], ownPID: own), .clear(number: 2, frame: moved))
    }

    func testAWindowNotOnScreenIsNotFound() {
        XCTAssertEqual(Rim.seen(pid: 5, number: nil, frame: tracker, windows: [window(2, 5, tracker.offsetBy(dx: 40, dy: 0))], ownPID: own), .notFound)
        XCTAssertEqual(Rim.seen(pid: 5, number: 9, frame: nil, windows: [window(2, 5, tracker)], ownPID: own), .notFound)
        // A window behind the target does not cover it.
        let windows = [window(2, 5, tracker), window(1, 7, tracker)]
        XCTAssertTrue(Rim.seen(pid: 5, number: nil, frame: tracker, windows: windows, ownPID: own).isClear)
    }

    /// DIRECTION.md 5.7's geometry: the ring's panel is the window plus the bloom; the figure's right
    /// edge 18 in from the window's, its top 13 above; the caption 12 in, its bottom 15 below.
    func testThePartsSitWhereTheSpecPutsThem() {
        let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
        let l = Rim.layout(window: tracker, perchHeight: 20, visible: visible)
        XCTAssertEqual(l.ring, tracker.insetBy(dx: -16, dy: -16))
        XCTAssertEqual(l.perch, CGRect(x: tracker.maxX - 18 - 22, y: tracker.minY - 13, width: 22, height: 20))
        XCTAssertEqual(l.caption, CGPoint(x: tracker.minX + 12, y: tracker.maxY + 15 - 26))
    }

    /// A window right under the menu bar keeps its figure on the screen, on the window's edge, and
    /// one at the bottom of the screen keeps its caption on it.
    func testAtTheScreensEdgesThePartsStayOnIt() {
        let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
        let top = CGRect(x: 100, y: 25, width: 600, height: 400)
        XCTAssertGreaterThanOrEqual(Rim.layout(window: top, perchHeight: 20, visible: visible).perch.minY, visible.minY)
        let bottom = CGRect(x: 100, y: 475, width: 600, height: 400)
        let caption = Rim.layout(window: bottom, perchHeight: 20, visible: visible).caption
        XCTAssertLessThanOrEqual(caption.y + Rim.captionHeight, visible.maxY)
    }

    func testTheCaptionsStepComesFromTheRowsProgress() {
        XCTAssertEqual(Rim.stepCount("Step 2 of 3"), "2 of 3")
        XCTAssertEqual(Rim.stepCount("Stopped before step 3 of 6"), "3 of 6")
        XCTAssertNil(Rim.stepCount("Watching"))
        XCTAssertNil(Rim.stepCount(nil))
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
