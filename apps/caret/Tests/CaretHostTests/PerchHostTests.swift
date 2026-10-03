import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import os
import XCTest
@testable import CaretHost

/// Records what the activity center would have written to the helper's socket.
final class RecordingSender: ActivitySending, @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: (controls: [TaskControl](), requests: [ActivityRequest]()))
    var connected = true

    func send(_ control: TaskControl) -> Bool {
        guard connected else { return false }
        lock.withLock { $0.controls.append(control) }
        return true
    }

    func send(_ request: ActivityRequest) -> Bool {
        guard connected else { return false }
        lock.withLock { $0.requests.append(request) }
        return true
    }

    var controls: [TaskControl] { lock.withLock { $0.controls } }
    var requests: [ActivityRequest] { lock.withLock { $0.requests } }
}

private func task(_ id: String, _ state: TaskState, pid: Int = 4242, updatedAt: Int64 = 1_000, undoable: Bool = false) -> TaskRecord {
    let json: [String: Any] = [
        "id": id, "kind": "plan", "state": state.rawValue, "cause": NSNull(), "says": "Fill the six fields",
        "app": ["pid": pid, "bundleId": "dev.caret.fixture", "name": "Caret Fixture"], "windowId": "\(pid)-1",
        "windowTitle": "Caret Fixture — Executor", "frame": [40, 60, 520, 420], "step": 2, "steps": 6, "stepSays": NSNull(), "remaining": [String](),
        "detail": NSNull(), "undoable": undoable, "startedAt": 500, "updatedAt": updatedAt, "pending": NSNull(),
    ]
    return try! JSONDecoder().decode(TaskRecord.self, from: JSONSerialization.data(withJSONObject: json))
}

private func inbound(_ object: [String: Any]) throws -> HelperInbound {
    try HelperInbound.decode(JSONSerialization.data(withJSONObject: object))
}

private func activityLine(_ seq: Int, _ record: TaskRecord) throws -> HelperInbound {
    let taskJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record))
    return try inbound(["type": "activity", "v": Proto.version, "seq": seq, "at": record.updatedAt, "from": NSNull(), "task": taskJSON])
}

private func replyLine(_ requestId: String, seq: Int, _ records: [TaskRecord]) throws -> HelperInbound {
    let tasks = try records.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
    return try inbound(["type": "activityReply", "v": Proto.version, "requestId": requestId, "error": NSNull(), "seq": seq, "tasks": tasks, "events": [Any](), "truncated": false])
}

@MainActor
final class ActivityCenterTests: XCTestCase {
    func testListsOnConnectAndAppliesOnlyItsOwnReply() throws {
        let sender = RecordingSender()
        let center = ActivityCenter()
        center.client = sender
        center.linkChanged(true)
        let request = try XCTUnwrap(sender.requests.first)
        XCTAssertEqual(request.op, .list)

        center.receive(try replyLine("someone-else", seq: 4, [task("x", .running)]))
        XCTAssertTrue(center.records.isEmpty, "a reply to another request is not ours")
        center.receive(try replyLine(request.requestId, seq: 4, [task("a", .running)]))
        XCTAssertEqual(center.records.map(\.id), ["a"])
        XCTAssertEqual(center.subject()?.mood, .working)
    }

    func testAGapListsAgain() throws {
        let sender = RecordingSender()
        let center = ActivityCenter()
        center.client = sender
        center.linkChanged(true)
        center.receive(try replyLine(sender.requests[0].requestId, seq: 4, []))
        center.receive(try activityLine(7, task("a", .running)))
        XCTAssertEqual(sender.requests.count, 2)
        XCTAssertEqual(center.stats.gaps, 1)
    }

    func testRowButtonsSendTaskControlOnceUntilTheRecordMoves() throws {
        let sender = RecordingSender()
        let center = ActivityCenter()
        center.client = sender
        center.linkChanged(true)
        center.receive(try replyLine(sender.requests[0].requestId, seq: 1, [task("run", .running, updatedAt: 1_000)]))

        XCTAssertTrue(center.control("run", .takeOver))
        XCTAssertEqual(sender.controls, [TaskControl(taskId: "run", action: .takeOver)])
        XCTAssertEqual(center.busy, ["run"])
        XCTAssertFalse(center.control("run", .takeOver), "the row waits for the helper's answer")

        // The helper's answer: paused, newer record. The row is free, and Continue resumes.
        center.receive(try activityLine(2, task("run", .paused, updatedAt: 2_000, undoable: true)))
        XCTAssertTrue(center.busy.isEmpty)
        XCTAssertEqual(center.rows().first?.actions, [.resume, .undo])
        XCTAssertTrue(center.control("run", .resume))
        XCTAssertEqual(sender.controls.last, TaskControl(taskId: "run", action: .resume))
    }

    func testNoControlForAnUnknownTaskOrWithoutTheHelper() throws {
        let sender = RecordingSender()
        let center = ActivityCenter()
        center.client = sender
        XCTAssertFalse(center.control("ghost", .undo))
        center.linkChanged(true)
        center.receive(try replyLine(sender.requests[0].requestId, seq: 1, [task("run", .done, undoable: true)]))
        sender.connected = false
        XCTAssertFalse(center.control("run", .undo))
        XCTAssertEqual(center.stats.controlsDropped, 1)
        XCTAssertTrue(center.busy.isEmpty)
    }

    func testDisconnectForgetsTheHelpersTasks() throws {
        let sender = RecordingSender()
        let center = ActivityCenter()
        center.client = sender
        center.linkChanged(true)
        center.receive(try replyLine(sender.requests[0].requestId, seq: 1, [task("run", .running)]))
        XCTAssertFalse(center.pauseGate.isEmpty)
        center.linkChanged(false)
        XCTAssertTrue(center.records.isEmpty)
        XCTAssertTrue(center.pauseGate.isEmpty, "no run, nothing to pause")
    }
}

/// Real input pausing a run, through the same `TapThread.route` the event tap calls for every
/// user key. No event is posted anywhere.
final class InputPauseTapTests: XCTestCase {
    private func harness() -> (TapThread, InputPauseGate, OSAllocatedUnfairLock<[[String]]>, XCTestExpectation) {
        let gate = InputPauseGate()
        let sent = OSAllocatedUnfairLock(initialState: [[String]]())
        let expectation = XCTestExpectation(description: "pause sent")
        let pauser = InputPauser(gate: gate) { ids, kind in
            XCTAssertEqual(kind, "key")
            sent.withLock { $0.append(ids) }
            expectation.fulfill()
        }
        let tap = TapThread(arbiter: OfferArbiter(), callbacks: TapThread.Callbacks(
            claimed: { _ in }, offerChanged: { _, _ in }, undo: { _ in }, keyDown: { _ in },
            realKey: { pauser.key(pid: $0) }, mouseDown: { pauser.click(at: $0) }
        ))
        return (tap, gate, sent, expectation)
    }

    func testARealKeyInTheRunsAppSendsPause() {
        let (tap, gate, sent, expectation) = harness()
        gate.update([task("run", .running, pid: 4242)], ownPID: 1)
        let consumed = tap.route(KeyStroke(keyCode: 0, text: "a", targetPID: 4242))
        XCTAssertFalse(consumed, "the key still reaches the app; pausing takes nothing from the user")
        wait(for: [expectation], timeout: 1)
        XCTAssertEqual(sent.withLock { $0 }, [["run"]])
    }

    func testKeysElsewhereSendNothing() {
        let (tap, gate, sent, expectation) = harness()
        expectation.isInverted = true
        gate.update([task("run", .running, pid: 4242)], ownPID: 1)
        tap.route(KeyStroke(keyCode: 0, text: "a", targetPID: 9999))
        tap.route(KeyStroke(keyCode: 0, text: "a", targetPID: nil))
        wait(for: [expectation], timeout: 0.3)
        XCTAssertTrue(sent.withLock { $0 }.isEmpty)
    }

    func testAPausedRunIsNotPausedAgain() {
        let (tap, gate, sent, expectation) = harness()
        gate.update([task("run", .paused, pid: 4242)], ownPID: 1)
        expectation.isInverted = true
        tap.route(KeyStroke(keyCode: 0, text: "a", targetPID: 4242))
        wait(for: [expectation], timeout: 0.3)
        XCTAssertTrue(sent.withLock { $0 }.isEmpty)
    }
}

/// The perch's renders and the list's, compared with their references like the other surfaces.
@MainActor
final class PerchSnapshotTests: XCTestCase {
    func testPerchStatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.perch())
    }

    func testActivityListMatchesItsReferences() throws {
        try SnapshotTests.check(Gallery.activity())
    }

    func testOtherCharactersRenderForReview() throws {
        guard let out = ProcessInfo.processInfo.environment["CARET_SNAPSHOT_OUT"].map({ URL(fileURLWithPath: $0) }) else { return }
        for character in [FigureCharacter.seed, .wren] {
            for item in Gallery.perch(character) {
                for dark in [false, true] {
                    let data = try XCTUnwrap(Gallery.png(item.view, dark: dark))
                    let url = out.appendingPathComponent("\(character.rawValue)/\(item.name)-\(dark ? "dark" : "light").png")
                    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: url)
                }
            }
        }
    }
}
