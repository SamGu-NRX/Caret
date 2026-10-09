import XCTest
@testable import CaretHostCore

final class AccessibilityAccessTests: XCTestCase {
    func testThePromptIsShownOnlyTheFirstTime() {
        XCTAssertTrue(AccessibilityAccess.shouldPrompt(asked: false, trusted: false))
        XCTAssertFalse(AccessibilityAccess.shouldPrompt(asked: true, trusted: false), "asked before: open the pane, no alert")
        XCTAssertFalse(AccessibilityAccess.shouldPrompt(asked: false, trusted: true))
    }

    func testAStaleGrantIsOnlyAChangedSignatureWhileUntrusted() {
        XCTAssertTrue(AccessibilityAccess.isStale(grantedSignature: "aa", currentSignature: "bb", trusted: false))
        XCTAssertFalse(AccessibilityAccess.isStale(grantedSignature: "aa", currentSignature: "aa", trusted: false), "same code: just switched off")
        XCTAssertFalse(AccessibilityAccess.isStale(grantedSignature: "aa", currentSignature: "bb", trusted: true))
        XCTAssertFalse(AccessibilityAccess.isStale(grantedSignature: nil, currentSignature: "bb", trusted: false), "never granted")
        XCTAssertFalse(AccessibilityAccess.isStale(grantedSignature: "aa", currentSignature: nil, trusted: false), "unreadable signature")
    }

    func testTheResetOnlyEverNamesCaretsOwnEntry() throws {
        XCTAssertEqual(try AccessibilityAccess.resetArguments(bundleID: "dev.caret.host"), ["reset", "Accessibility", "dev.caret.host"])
        for other in ["com.apple.Terminal", "dev.caret.fixture", "dev.caret", "", "dev.caret.host.evil"] {
            XCTAssertThrowsError(try AccessibilityAccess.resetArguments(bundleID: other), other)
        }
        XCTAssertThrowsError(try AccessibilityAccess.resetArguments(bundleID: nil))
    }

    func testThePaneIsNamedForTheSystem() {
        XCTAssertEqual(AccessibilityAccess.paneName(osMajor: 26), "Accessibility")
        XCTAssertEqual(AccessibilityAccess.paneName(osMajor: 27), "Device Control and Data Access")
        XCTAssertEqual(AccessibilityAccess.paneURLs.first?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    func testANoticeReadsTheGrantOnceAfterItSettles() {
        let clock = ManualClock()
        var reads = 0
        let detection = GrantDetection(clock: clock) { reads += 1 }
        detection.changed()
        detection.changed()
        clock.advance(by: GrantDetection.settle - 0.01)
        XCTAssertEqual(reads, 0, "not before tccd has had time to write the change")
        clock.advance(by: 0.02)
        XCTAssertEqual(reads, 1, "two notices inside the wait make one read")
        detection.changed()
        clock.advance(by: GrantDetection.settle)
        XCTAssertEqual(reads, 2)
    }
}
