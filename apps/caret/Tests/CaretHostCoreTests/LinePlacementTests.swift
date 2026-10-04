import CoreGraphics
import XCTest
@testable import CaretHostCore

final class LinePlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)

    /// The claim form from A2's run 6, in points: fields 23 tall, 52 apart, so 29 pt between them.
    func field(_ row: Int) -> CGRect { CGRect(x: 710, y: 134 + CGFloat(row) * 52, width: 319, height: 23) }

    func testRoomAboveKeepsTheStandardSpot() {
        let choice = LinePlacement.choose(field: field(0), width: 300, compactWidth: 240, obstacles: [], bounds: screen)
        XCTAssertEqual(choice.side, .above)
        XCTAssertFalse(choice.compact)
        XCTAssertEqual(choice.frame, CGRect(x: 729, y: 134 - 6 - 28, width: 300, height: 28))
    }

    func testATightFormShrinksTheLineSoItCoversNeitherNeighbor() {
        // The line for row 1 would cover the right end of row 0 above and row 2 below.
        let obstacles = [field(0), field(2), field(3)]
        let choice = LinePlacement.choose(field: field(1), width: 300, compactWidth: 240, obstacles: obstacles, bounds: screen)
        XCTAssertTrue(choice.compact)
        XCTAssertEqual(choice.side, .above)
        XCTAssertEqual(choice.overlap, 0)
        XCTAssertFalse(choice.frame.intersects(field(0)))
        XCTAssertFalse(choice.frame.intersects(field(1)))
        XCTAssertEqual(choice.frame.maxX, field(1).maxX, "right-aligned to the field")
    }

    func testALabelAboveTheFieldFlipsTheLineBelow() {
        // "Company" sits right above its field; the field below is far away.
        let company = CGRect(x: 712, y: 300, width: 60, height: 16)
        let target = CGRect(x: 710, y: 320, width: 319, height: 23)
        let next = CGRect(x: 710, y: 400, width: 319, height: 23)
        let choice = LinePlacement.choose(
            field: target, width: 300, compactWidth: 240,
            obstacles: [company, next, CGRect(x: 729, y: 290, width: 300, height: 10)], bounds: screen
        )
        XCTAssertEqual(choice.side, .below)
        XCTAssertFalse(choice.compact)
        XCTAssertEqual(choice.overlap, 0)
    }

    func testWhenEverythingIsCoveredTheCompactLineWithLeastOverlapWins() {
        let wall = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let choice = LinePlacement.choose(field: field(1), width: 300, compactWidth: 240, obstacles: [wall], bounds: screen)
        XCTAssertTrue(choice.compact)
    }

    func testTheLineStaysOnScreen() {
        let edge = CGRect(x: 1400, y: 4, width: 100, height: 23)
        let choice = LinePlacement.choose(field: edge, width: 300, compactWidth: 240, obstacles: [], bounds: screen)
        XCTAssertEqual(choice.side, .below, "no room above at the top of the screen")
        XCTAssertLessThanOrEqual(choice.frame.maxX, screen.maxX - LinePlacement.margin)
    }

    func testOneSurfaceGivesWay() {
        XCTAssertEqual(FillLineRule.resolve(toastSource: nil, offerSource: "from Mail"), .showLine)
        XCTAssertEqual(FillLineRule.resolve(toastSource: "from Mail", offerSource: "from Mail"), .deferLine)
        XCTAssertEqual(FillLineRule.resolve(toastSource: "from Mail", offerSource: "from Notes"), .replaceToast)
    }
}
