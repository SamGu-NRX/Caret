import CoreGraphics
import XCTest
@testable import CaretHostCore

/// The coach slip never covers the line being typed.
final class CoachSlipPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let slip = CGSize(width: 260, height: 26)

    func testSitsUnderTheLineClearOfIt() {
        let line = CGRect(x: 640, y: 600, width: 1, height: 18)
        let frame = CoachSlipPlacement.frame(line: line, slip: slip, visible: screen)
        XCTAssertFalse(frame.intersects(line.insetBy(dx: -400, dy: 0)), "nothing of the line's height is covered")
        XCTAssertEqual(frame.maxY, line.minY - CoachSlipPlacement.gap)
        XCTAssertEqual(frame.minX, line.minX - CoachSlipPlacement.lead)
    }

    func testGoesAboveWhenTheLineIsAtTheScreensFoot() {
        let line = CGRect(x: 640, y: 10, width: 1, height: 18)
        let frame = CoachSlipPlacement.frame(line: line, slip: slip, visible: screen)
        XCTAssertEqual(frame.minY, line.maxY + CoachSlipPlacement.gap)
        XCTAssertFalse(frame.intersects(CGRect(x: 0, y: line.minY, width: 1440, height: line.height)))
    }

    func testStaysOnScreenAtTheRightEdge() {
        let line = CGRect(x: 1430, y: 600, width: 1, height: 18)
        let frame = CoachSlipPlacement.frame(line: line, slip: slip, visible: screen)
        XCTAssertLessThanOrEqual(frame.maxX, screen.maxX)
        XCTAssertGreaterThanOrEqual(frame.minX, screen.minX)
    }
}
