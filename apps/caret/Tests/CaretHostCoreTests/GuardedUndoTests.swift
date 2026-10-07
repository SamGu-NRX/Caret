import XCTest
@testable import CaretHostCore

/// S2 focused check, F1: ⌘Z's captured input mark guards every write an undo makes, checked
/// immediately before each one and after the last target check, with the exact value and
/// selection revalidated before the text write. `GuardedUndo.run` is the insertion queue's AX undo
/// with the app behind `UndoTarget`; this fake app records every write it is sent.
final class GuardedUndoTests: XCTestCase {
    private final class FakeApp: UndoTarget {
        var value: String
        var selection: UTF16Selection
        var quietNow = true
        var targetHeld = true
        /// Every write, in order: "select a-b" or "write <text>".
        var writes: [String] = []
        /// Runs at each permit check (target, then quiet), by its index: what the user does between Caret's steps.
        var onCheck: [Int: (FakeApp) -> Void] = [:]
        private var checks = 0
        let target = TargetIdentity(pid: 5150, bundleID: "dev.caret.fixture", windowID: "w41", elementID: "body", elementRevision: "")

        init(_ value: String, caret: Int) {
            self.value = value
            selection = .caret(caret)
        }

        func refusal() -> String? {
            checks += 1
            onCheck[checks]?(self)
            return targetHeld ? nil : "targetNotAllowed"
        }

        func quiet() -> Bool { quietNow }

        func read() -> InsertionGuard.LiveField? {
            var t = target
            t.elementRevision = UTF16Text.digest(value)
            return InsertionGuard.LiveField(target: t, value: value, selection: selection)
        }

        func select(_ s: UTF16Selection) -> Bool {
            writes.append("select \(s.start)-\(s.end)")
            selection = s
            return true
        }

        func replaceSelection(_ text: String) -> WriteFallback.AXAnswer {
            writes.append("write \(text)")
            value = UTF16Text.slice(value, start: 0, end: selection.start)! + text + UTF16Text.slice(value, start: selection.end, end: UTF16Text.length(value))!
            selection = .caret(selection.start + UTF16Text.length(text))
            return .accepted
        }

        func sleep(_ seconds: TimeInterval) { now.addTimeInterval(seconds) }
        var now = Date(timeIntervalSince1970: 0)
    }

    /// A partial grant: "Da" of "Dana" went in at 3 of "Hi  there".
    private func partial() -> UndoGrant {
        let before = "Hi  there"
        let target = TargetIdentity(pid: 5150, bundleID: "dev.caret.fixture", windowID: "w41", elementID: "body", elementRevision: UTF16Text.digest(before))
        let edit = InsertionGuard.ApprovedEdit(target: target, replaceStart: 3, replaceEnd: 3, replacement: "Dana", resultingValue: "Hi Dana there")
        let armed = UndoGrant.armed(target: target, priorValue: before, edit: edit, origin: nil, writeID: 1)
        let report = UnconfirmedInsert.read(UnconfirmedInsert.Intent(before: before, start: 3, end: 3, replacement: "Dana"), held: "Hi Da there")
        return UnconfirmedInsert.grant(armed: armed, verified: false, report: report)!
    }

    func testAQuietFieldIsRestoredAndOnlyCaretsSpanIsWritten() {
        let app = FakeApp("Hi Da there", caret: 5)
        let outcome = GuardedUndo.run(partial(), on: app, settleTimeout: 1)
        XCTAssertEqual(outcome, GuardedUndo.Outcome(ok: true, error: nil, partial: true))
        XCTAssertEqual(app.writes, ["select 3-5", "write "])
        XCTAssertEqual(app.value, "Hi  there")
    }

    /// The user's key lands after the selection recheck and the target check that follows it: the
    /// quiet check right before the text write catches it, and nothing is deleted.
    func testInputAfterTheLastTargetCheckStopsTheTextWrite() {
        let app = FakeApp("Hi Da there", caret: 5)
        // Check 1 precedes the selection, check 2 the text write.
        app.onCheck[2] = { $0.quietNow = false }
        let outcome = GuardedUndo.run(partial(), on: app, settleTimeout: 1)
        XCTAssertEqual(outcome.error, "inputDuringUndo")
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(app.writes, ["select 3-5"], "no text write, and no selection put back over the user's input")
        XCTAssertEqual(app.value, "Hi Da there")
    }

    /// The selection moved between Caret's select and its recheck (a click): refused, and the
    /// value is untouched. The selection is put back only when nobody else moved it.
    func testASelectionMovedBeforeTheWriteIsRefused() {
        let moving = MovingApp("Hi Da there", caret: 5)
        let outcome = GuardedUndo.run(partial(), on: moving, settleTimeout: 1)
        XCTAssertEqual(outcome.error, "selectionMoved")
        XCTAssertEqual(moving.writes, ["select 3-5"])
        XCTAssertEqual(moving.value, "Hi Da there")
    }

    /// A user who was not quiet at ⌘Z's first step gets no write at all.
    func testInputBeforeTheFirstWriteWritesNothing() {
        let app = FakeApp("Hi Da there", caret: 5)
        app.quietNow = false
        XCTAssertEqual(GuardedUndo.run(partial(), on: app, settleTimeout: 1).error, "inputDuringUndo")
        XCTAssertEqual(app.writes, [])
    }

    /// The permit every undo write asks, the writing fix's AX restore included: the target first,
    /// then the captured input mark.
    func testThePermitPutsTheTargetFirstThenTheInputMark() {
        XCTAssertNil(GuardedUndo.permit(refusal: nil, quiet: true))
        XCTAssertEqual(GuardedUndo.permit(refusal: nil, quiet: false), "inputDuringUndo")
        XCTAssertEqual(GuardedUndo.permit(refusal: "revoked", quiet: false), "revoked")
    }

    /// A fake whose selection a click moves as soon as Caret selects.
    private final class MovingApp: UndoTarget {
        var value: String
        var selection: UTF16Selection
        var writes: [String] = []
        init(_ value: String, caret: Int) {
            self.value = value
            selection = .caret(caret)
        }
        func refusal() -> String? { nil }
        func quiet() -> Bool { true }
        func read() -> InsertionGuard.LiveField? {
            var t = TargetIdentity(pid: 5150, bundleID: "dev.caret.fixture", windowID: "w41", elementID: "body", elementRevision: "")
            t.elementRevision = UTF16Text.digest(value)
            return InsertionGuard.LiveField(target: t, value: value, selection: selection)
        }
        func select(_ s: UTF16Selection) -> Bool {
            writes.append("select \(s.start)-\(s.end)")
            selection = UTF16Selection(start: 0, end: 5)
            return true
        }
        func replaceSelection(_ text: String) -> WriteFallback.AXAnswer {
            writes.append("write \(text)")
            return .accepted
        }
        func sleep(_ seconds: TimeInterval) {}
        var now: Date { Date(timeIntervalSince1970: 0) }
    }
}
