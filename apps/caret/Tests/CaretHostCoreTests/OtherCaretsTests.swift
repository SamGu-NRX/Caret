import XCTest
@testable import CaretHostCore

/// Sam's beta ran untrusted because the switch he flipped belonged to another app named Caret.
final class OtherCaretsTests: XCTestCase {
    let mine = "/Applications/Caret 2.app"

    func testTheRunningCopyIsNeverAnOther() {
        let installed = [OtherCaret(bundleID: "dev.caret.host", path: mine), OtherCaret(bundleID: "dev.caret.hackathon", path: "/Applications/Caret.app"),
                         OtherCaret(bundleID: "dev.caret.hackathon", path: "/Applications/Caret.app/")]
        let others = OtherCarets.others(installed: installed, runningPath: mine + "/")
        XCTAssertEqual(others.map(\.path), ["/Applications/Caret.app"], "the running copy goes, and one path is listed once")
        XCTAssertEqual(others.first?.place, "Caret.app in /Applications")
    }

    func testAnotherCopyOfCaret2ElsewhereCounts() {
        let others = OtherCarets.others(installed: [OtherCaret(bundleID: "dev.caret.host", path: "/Users/sam/Downloads/Caret.app")], runningPath: mine)
        XCTAssertEqual(others.count, 1)
    }

    func testTheWrongCaretIsNamedOnlyAfterAChangeWhileStillUntrusted() {
        let other = [OtherCaret(bundleID: "dev.caret.hackathon", path: "/Applications/Caret.app")]
        XCTAssertTrue(OtherCarets.wrongOneTurnedOn(changeNoticed: true, trusted: false, others: other))
        XCTAssertFalse(OtherCarets.wrongOneTurnedOn(changeNoticed: false, trusted: false, others: other), "nothing flipped yet")
        XCTAssertFalse(OtherCarets.wrongOneTurnedOn(changeNoticed: true, trusted: true, others: other))
        XCTAssertFalse(OtherCarets.wrongOneTurnedOn(changeNoticed: true, trusted: false, others: []), "no other Caret to blame")
    }
}
