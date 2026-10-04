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

    func testAnIgnoredPastePasteFallsBackToAX() {
        XCTAssertEqual(WriteFallback.afterPaste(.unchanged, usedPasteboard: true, postError: nil), .fallBackToAX)
    }

    func testAnIgnoredInjectionDoesNotFallBack() {
        XCTAssertEqual(WriteFallback.afterPaste(.unchanged, usedPasteboard: false, postError: nil), .failed("writeIgnored"))
    }

    func testAMismatchIsNeverRetried() {
        XCTAssertEqual(WriteFallback.afterPaste(.different, usedPasteboard: true, postError: nil), .failed("writeMismatch"),
                       "a second write could double the value")
    }

    func testARefusedPostIsReportedAsSuch() {
        XCTAssertEqual(WriteFallback.afterPaste(.different, usedPasteboard: true, postError: "targetNotAllowed"), .failed("targetNotAllowed"))
    }

    func testAMatchedPasteIsVerified() {
        XCTAssertEqual(WriteFallback.afterPaste(.matched, usedPasteboard: true, postError: nil), .verified)
    }

    func testALatePasteAfterTheFallbackIsTheInsertionTwiceAtTheCaret() {
        XCTAssertEqual(WriteFallback.lateDuplicate(original: "", start: 0, end: 0, replacement: "Lumen Labs"), "Lumen LabsLumen Labs")
        XCTAssertEqual(WriteFallback.lateDuplicate(original: "Dear , hi", start: 5, end: 5, replacement: "Dana"), "Dear DanaDana, hi")
        XCTAssertNil(WriteFallback.lateDuplicate(original: "ab", start: 3, end: 3, replacement: "x"))
    }

    func testTheAXRouteHasNoFurtherFallback() {
        XCTAssertEqual(WriteFallback.afterAX(.matched), .verified)
        XCTAssertEqual(WriteFallback.afterAX(.unchanged), .failed("writeIgnored"))
        XCTAssertEqual(WriteFallback.afterAX(.different), .failed("writeMismatch"))
    }
}
