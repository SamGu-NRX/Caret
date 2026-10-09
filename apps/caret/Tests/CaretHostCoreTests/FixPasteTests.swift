import XCTest
@testable import CaretHostCore

final class FixPasteTests: XCTestCase {
    let before = "I left early becuase "
    let expected = "I left early because "

    func testThePredictedValueIsApplied() {
        XCTAssertEqual(FixPaste.afterPaste(value: expected, before: before, expected: expected), .applied)
    }

    func testAnUnchangedValueNeedsNoUndo() {
        XCTAssertEqual(FixPaste.afterPaste(value: before, before: before, expected: expected), .untouched)
    }

    func testAnythingElseIsTakenBack() {
        XCTAssertEqual(FixPaste.afterPaste(value: "I left early because because ", before: before, expected: expected), .mismatch)
        XCTAssertEqual(FixPaste.afterPaste(value: nil, before: before, expected: expected), .mismatch, "unreadable is not applied")
        // Unit for unit: a composed é is not e plus a combining accent.
        XCTAssertEqual(FixPaste.afterPaste(value: "caf\u{E9}", before: "cafe", expected: "cafe\u{301}"), .mismatch)
    }

    func testTheUndoMustRestoreTheValueExactly() {
        XCTAssertEqual(FixPaste.afterUndo(value: before, before: before), .fixUndone)
        XCTAssertEqual(FixPaste.afterUndo(value: "I left early ", before: before), .fixNotRestored)
        XCTAssertEqual(FixPaste.afterUndo(value: nil, before: before), .fixNotRestored)
    }

    func testFixesStopOnlyAfterASelectionThatNeverTookOrAnUnprovenRestore() {
        XCTAssertFalse(FixPaste.keepsFixes(after: "selectionNotTaken"))
        XCTAssertFalse(FixPaste.keepsFixes(after: "fixNotRestored"))
        XCTAssertTrue(FixPaste.keepsFixes(after: "fixUndone"))
        XCTAssertTrue(FixPaste.keepsFixes(after: "revisionChanged"))
    }

    func testEachFailureHasItsOwnLine() {
        XCTAssertEqual(WritingCopy.notFixed("fixUndone"), "Caret couldn't fix that here.")
        XCTAssertEqual(WritingCopy.notFixed("selectionNotTaken"), "This app didn't take the fix, so nothing changed.")
        XCTAssertNotEqual(WritingCopy.notFixed("fixNotRestored"), WritingCopy.notFixed("fixUndone"), "an unproven restore says so")
    }
}

final class KeyHoldQueueTests: XCTestCase {
    func testKeysForTheHeldAppWaitAndComeOutInOrder() {
        var q = KeyHoldQueue<String>()
        XCTAssertTrue(q.begin(pid: 7, now: 0).isEmpty)
        for k in ["o", "k"] {
            guard case .hold = q.take(k, pid: 7, now: 1) else { return XCTFail("\(k) should be held") }
        }
        XCTAssertEqual(q.end(), ["o", "k"])
        XCTAssertNil(q.pid)
    }

    func testKeysForAnotherAppPass() {
        var q = KeyHoldQueue<String>()
        _ = q.begin(pid: 7, now: 0)
        guard case .pass(let first) = q.take("x", pid: 8, now: 1) else { return XCTFail("another app's key passes") }
        XCTAssertTrue(first.isEmpty)
        guard case .pass = q.take("y", pid: nil, now: 1) else { return XCTFail("a key with no target passes") }
    }

    func testNoHoldPassesEverything() {
        var q = KeyHoldQueue<String>()
        guard case .pass(let first) = q.take("x", pid: 7, now: 1) else { return XCTFail("no hold, no holding") }
        XCTAssertTrue(first.isEmpty)
    }

    func testAnExpiredHoldLetsTheHeldKeysGoFirst() {
        var q = KeyHoldQueue<String>()
        _ = q.begin(pid: 7, now: 0)
        _ = q.take("a", pid: 7, now: 1)
        guard case .pass(let first) = q.take("b", pid: 7, now: KeyHoldQueue<String>.maxHoldNanos + 1) else {
            return XCTFail("an expired hold holds nothing more")
        }
        XCTAssertEqual(first, ["a"])
        XCTAssertNil(q.pid)
    }

    func testANewHoldHandsBackWhatTheLastOneHeld() {
        var q = KeyHoldQueue<String>()
        _ = q.begin(pid: 7, now: 0)
        _ = q.take("a", pid: 7, now: 1)
        XCTAssertEqual(q.begin(pid: 9, now: 2), ["a"])
        XCTAssertEqual(q.pid, 9)
    }
}
