import AutocompleteCore
import CaretHostCore
import MacContextCapture
import XCTest
@testable import CaretHost

/// PR #16 review: an extension drawn after a scroll used the caret's place from before it.
@MainActor
final class ExtendGeometryTests: XCTestCase {
    func snap(_ y: CGFloat) -> FocusedFieldSnapshot {
        FocusedFieldSnapshot(context: TextFieldContext(beforeCursor: "Thanks for", target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit")),
                             caretRect: CGRect(x: 100, y: y, width: 1, height: 16), caretSource: nil, caretQuality: nil)
    }

    func field(_ value: String) -> TargetIdentity {
        TargetIdentity(pid: 1, bundleID: "com.apple.TextEdit", windowID: "w", elementID: "e", elementRevision: UTF16Text.digest(value))
    }

    func testTheLatestReadOfTheSameFieldWins() {
        let drawn = HostCoordinator.drawSnapshot(held: snap(200), heldField: field("Thanks for"), latest: (field("Thanks for"), snap(140)))
        XCTAssertEqual(drawn.caretRect?.minY, 140, "scrolled up 60 pt while the second request ran")
    }

    func testAnotherFieldOrValueKeepsTheHeldOne() {
        XCTAssertEqual(HostCoordinator.drawSnapshot(held: snap(200), heldField: field("Thanks for"), latest: (field("Thanks fo"), snap(140))).caretRect?.minY, 200)
        XCTAssertEqual(HostCoordinator.drawSnapshot(held: snap(200), heldField: field("Thanks for"), latest: nil).caretRect?.minY, 200)
    }
}
