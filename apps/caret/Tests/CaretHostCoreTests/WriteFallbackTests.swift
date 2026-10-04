import XCTest
@testable import CaretHostCore

final class WriteFallbackTests: XCTestCase {
    private func classify(_ value: String?, same: Bool = true, elapsed: TimeInterval) -> WriteFallback.Settle? {
        WriteFallback.classify(
            value: value, sameElement: same, expected: "Lumen Labs", unchanged: "",
            elapsed: elapsed, ignoredAfter: 0.5, timeout: 1.5
        )
    }

    func testTheExpectedValueInTheSameElementIsAMatch() {
        XCTAssertEqual(classify("Lumen Labs", elapsed: 0.02), .matched)
    }

    func testTheExpectedValueInAnotherElementIsNotAMatch() {
        XCTAssertEqual(classify("Lumen Labs", same: false, elapsed: 0.02), .different)
    }

    func testAnUntouchedFieldKeepsPollingUntilTheIgnoreWindow() {
        XCTAssertNil(classify("", elapsed: 0.1), "an app may apply a paste a few frames late")
        XCTAssertEqual(classify("", elapsed: 0.5), .unchanged)
    }

    func testPartialTextKeepsPollingThenFails() {
        XCTAssertNil(classify("Lumen", elapsed: 1.0))
        XCTAssertEqual(classify("Lumen", elapsed: 1.5), .different)
    }

    func testAnUnreadableFieldAtTimeoutIsAFailureNotAnIgnoredPaste() {
        XCTAssertEqual(classify(nil, elapsed: 1.5), .different)
    }

    /// AX first (A17): only an AX error moves to the pid paste. An AX write the app took and did not
    /// show may still land, so it fails rather than risk a second copy; a mismatch never retries.
    func testTheAXRouteComesFirstAndFallsBackToPasteOnlyWhenTheAppRefusedIt() {
        XCTAssertEqual(WriteFallback.afterAX(.matched, refused: false), .verified)
        XCTAssertEqual(WriteFallback.afterAX(nil, refused: true), .fallBackToPaste, "the app refused the AX write")
        XCTAssertEqual(WriteFallback.afterAX(.unchanged, refused: false), .failed("writeIgnored"), "the app took it and showed nothing: no second write")
        XCTAssertEqual(WriteFallback.afterAX(.different, refused: false), .failed("writeMismatch"), "a second write could double the value")
    }

    func testThePasteHasNoFurtherFallback() {
        XCTAssertEqual(WriteFallback.afterPaste(.matched, postError: nil), .verified)
        XCTAssertEqual(WriteFallback.afterPaste(.unchanged, postError: nil), .failed("writeIgnored"))
        XCTAssertEqual(WriteFallback.afterPaste(.different, postError: nil), .failed("writeMismatch"))
        XCTAssertEqual(WriteFallback.afterPaste(.different, postError: "revoked"), .failed("revoked"))
    }

    // MARK: - S1 audit #13: focus moves between the check and the post

    /// The check passed with Name focused; before the app handled the posted ⌘V, focus moved to
    /// Email, and the paste landed there. Name is unchanged, so the after-read looks in Email: the
    /// pasted text ends exactly at its caret, and the failure names Email.
    func testAPasteThatLandedInTheFieldThatTookFocusIsFoundThereByItsSpan() {
        let span = WriteFallback.strayInsertion(focusIsApproved: false, value: "dana@example.comLumen Labs", caret: 26, inserted: "Lumen Labs")
        XCTAssertEqual(span?.start, 16)
        XCTAssertEqual(span?.length, 10)
        let mid = WriteFallback.strayInsertion(focusIsApproved: false, value: "ab Lumen Labs cd", caret: 13, inserted: "Lumen Labs")
        XCTAssertEqual(mid?.start, 3, "a paste in the middle of the other field")
    }

    func testNothingIsTakenFromAFieldThatDoesNotEndInThePaste() {
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: true, value: "Lumen Labs", caret: 10, inserted: "Lumen Labs"), "focus never moved")
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: false, value: "Lumen Lab", caret: 9, inserted: "Lumen Labs"), "the user's own typing")
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: false, value: "Lumen Labs!", caret: 11, inserted: "Lumen Labs"), "something after it")
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: false, value: "Lumen Labs", caret: nil, inserted: "Lumen Labs"), "a selection, not a caret")
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: false, value: nil, caret: 0, inserted: "Lumen Labs"), "unreadable")
        XCTAssertNil(WriteFallback.strayInsertion(focusIsApproved: false, value: "x", caret: 1, inserted: ""))
    }
}
