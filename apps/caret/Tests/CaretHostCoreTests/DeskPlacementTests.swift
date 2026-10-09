import CaretHostCore
import CoreGraphics
import XCTest

/// Bug 13 (A18): the ask panel opens under the menu bar of the screen holding the window in front,
/// centered over that window. Q1's 2560-wide main display with a 1512-wide display below it.
final class DeskPlacementTests: XCTestCase {
    private let main = CGRect(x: 0, y: 25, width: 2560, height: 1390)
    private let below = CGRect(x: 541, y: 1440, width: 1512, height: 950)
    private let width: CGFloat = 340

    func testItOpensOverChromeAtTheLeftOfAWideScreen() {
        let chrome = CGRect(x: 40, y: 120, width: 1200, height: 900)
        let screen = DeskPlacement.screen(for: chrome, screens: [main, below], fallback: below)
        XCTAssertEqual(screen, main)
        let p = DeskPlacement.topLeft(width: width, visible: screen, window: chrome)
        XCTAssertEqual(p, CGPoint(x: 470, y: 35), "centered over the window, 10 pt under the menu bar")
        XCTAssertLessThan(abs(p.x + width / 2 - chrome.midX), 1)
    }

    func testItOpensOnTheScreenHoldingMostOfTheWindow() {
        let window = CGRect(x: 700, y: 1300, width: 800, height: 700)
        XCTAssertEqual(DeskPlacement.screen(for: window, screens: [main, below], fallback: main), below)
        let p = DeskPlacement.topLeft(width: width, visible: below, window: window)
        XCTAssertEqual(p.y, below.minY + DeskPlacement.gap)
        XCTAssertEqual(p.x, 930)
    }

    func testANarrowWindowAtTheEdgeKeepsTheDeskOnScreen() {
        let window = CGRect(x: 2440, y: 300, width: 300, height: 400)
        let p = DeskPlacement.topLeft(width: width, visible: main, window: window)
        XCTAssertEqual(p.x, main.maxX - DeskPlacement.margin - width)
        let left = DeskPlacement.topLeft(width: width, visible: main, window: CGRect(x: -100, y: 300, width: 200, height: 400))
        XCTAssertEqual(left.x, main.minX + DeskPlacement.margin)
    }

    func testWithNoWindowItSitsUnderTheMenuBarGlyph() {
        XCTAssertEqual(DeskPlacement.screen(for: nil, screens: [main, below], fallback: below), below)
        let p = DeskPlacement.topLeft(width: width, visible: main, window: nil)
        XCTAssertEqual(p, CGPoint(x: main.maxX - DeskPlacement.margin - width, y: 35))
    }

    func testAWindowOffEveryScreenFallsBack() {
        let gone = CGRect(x: 5000, y: 5000, width: 400, height: 300)
        XCTAssertEqual(DeskPlacement.screen(for: gone, screens: [main, below], fallback: below), below)
        let p = DeskPlacement.topLeft(width: width, visible: below, window: gone)
        XCTAssertEqual(p.x, below.maxX - DeskPlacement.margin - width, "a window not on this screen is not centered on")
    }
}
