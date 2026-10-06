import CoreGraphics
import XCTest
@testable import CaretHostCore

/// The caret-line rule alternatives and ghost capsules share (V1a check 4). Top-left points.
final class CaretLinePlacementTests: XCTestCase {
    /// A TextEdit document: its visible text area inside a 960 x 480 window on a 960 x 600 display.
    private let window = CGRect(x: 0, y: 30, width: 960, height: 480)
    private let viewport = CGRect(x: 0, y: 62, width: 943, height: 448)
    private let display = CGRect(x: 0, y: 25, width: 960, height: 575)
    private let size = CGSize(width: 80, height: 24)

    private func line(x: CGFloat = 400, y: CGFloat) -> CGRect { CGRect(x: x, y: y, width: 1, height: 16) }

    private var areas: [CGRect] { CaretLinePlacement.areas(viewport: viewport, window: window, display: display) }

    private func assertClearOfLine(_ spot: CaretLinePlacement.Spot, _ caret: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(spot.frame.minY >= caret.maxY + CaretLinePlacement.gap || spot.frame.maxY <= caret.minY - CaretLinePlacement.gap,
                      "the caret's line stays clear: \(spot.frame) vs \(caret)", file: file, line: line)
    }

    func testMidDocumentTheCapsuleGoesBelowTheCaretsLineCenteredOnTheCaret() throws {
        let caret = line(y: 200)
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: caret, areas: areas))
        XCTAssertEqual(spot.side, .below)
        XCTAssertEqual(spot.frame, CGRect(x: 360.5, y: 221, width: 80, height: 24))
        XCTAssertEqual(spot.area, 0, "inside the visible text area")
        XCTAssertFalse(spot.bounded)
        assertClearOfLine(spot, caret)
    }

    func testOnTheLastVisibleLineItGoesAbove() throws {
        let caret = line(y: 490)
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: caret, areas: areas))
        XCTAssertEqual(spot.side, .above)
        XCTAssertEqual(spot.frame.maxY, caret.minY - CaretLinePlacement.gap)
        XCTAssertTrue(viewport.contains(spot.frame))
        assertClearOfLine(spot, caret)
    }

    func testAtTheRightEdgeItSlidesInside() throws {
        let caret = line(x: 935, y: 200)
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: caret, areas: areas))
        XCTAssertEqual(spot.frame.maxX, viewport.maxX)
    }

    func testACandidateWiderThanTheAreaIsBoundedToIt() throws {
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: CGSize(width: 2000, height: 24), caretLine: line(y: 200), areas: areas))
        XCTAssertTrue(spot.bounded)
        XCTAssertEqual(spot.frame.width, viewport.width)
        XCTAssertTrue(viewport.contains(spot.frame))
    }

    func testANarrowViewportBoundsTheCapsuleToItsWidth() throws {
        let narrow = CaretLinePlacement.areas(viewport: CGRect(x: 380, y: 62, width: 60, height: 448), window: window, display: display)
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: line(y: 200), areas: narrow))
        XCTAssertEqual(spot.area, 0)
        XCTAssertEqual(spot.frame.width, 60)
        XCTAssertTrue(spot.bounded)
    }

    /// A single-line field's viewport is one line tall: the capsule goes under the field, inside the
    /// window, as A9's did.
    func testASingleLineFieldUsesTheWindow() throws {
        let field = CGRect(x: 200, y: 140, width: 260, height: 22)
        let caret = CGRect(x: 300, y: 143, width: 1, height: 16)
        let areas = CaretLinePlacement.areas(viewport: field, window: CGRect(x: 100, y: 100, width: 600, height: 400), display: display)
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: caret, areas: areas))
        XCTAssertEqual(spot.area, 1)
        XCTAssertEqual(spot.side, .below)
        assertClearOfLine(spot, caret)
    }

    func testTheDisplayClipsTheWindow() throws {
        // A window running past the display's bottom: below the last line on screen there is no room.
        let tall = CGRect(x: 0, y: 30, width: 960, height: 900)
        let areas = CaretLinePlacement.areas(viewport: nil, window: tall, display: display)
        XCTAssertEqual(areas, [CGRect(x: 0, y: 30, width: 960, height: 570)])
        let spot = try XCTUnwrap(CaretLinePlacement.place(size: size, caretLine: line(y: 580), areas: areas))
        XCTAssertEqual(spot.side, .above)
    }

    func testNoRoomOnEitherSideIsNil() {
        let short = [CGRect(x: 0, y: 190, width: 960, height: 40)]
        XCTAssertNil(CaretLinePlacement.place(size: size, caretLine: line(y: 200), areas: short))
    }

    func testWithoutAWindowThereIsNoArea() {
        XCTAssertEqual(CaretLinePlacement.areas(viewport: viewport, window: nil, display: display), [])
        XCTAssertEqual(CaretLinePlacement.areas(viewport: viewport, window: CGRect(x: 2000, y: 0, width: 100, height: 100), display: display), [])
    }

    func testAViewportEqualToTheWindowIsTriedOnce() {
        XCTAssertEqual(CaretLinePlacement.areas(viewport: window, window: window, display: nil), [window])
    }

    func testFlippingIsItsOwnInverse() {
        let r = CGRect(x: 3, y: 40, width: 10, height: 20)
        XCTAssertEqual(CaretLinePlacement.flipped(r), CGRect(x: 3, y: -60, width: 10, height: 20))
        XCTAssertEqual(CaretLinePlacement.flipped(CaretLinePlacement.flipped(r)), r)
    }

    // MARK: - Shortening

    /// 7 pt a character.
    private func measure(_ s: String) -> CGFloat { CGFloat(s.count) * 7 }

    func testTextThatFitsIsKept() {
        XCTAssertEqual(CaretLinePlacement.truncated("see you", toWidth: 49, measure: measure), "see you")
    }

    func testLongTextEndsInAnEllipsisWithinTheWidth() throws {
        let short = try XCTUnwrap(CaretLinePlacement.truncated(" in section two of the draft", toWidth: 70, measure: measure))
        XCTAssertTrue(short.hasSuffix("…"))
        XCTAssertLessThanOrEqual(measure(short), 70)
        XCTAssertEqual(short, " in secti…")
    }

    func testNoSpaceIsLeftBeforeTheEllipsis() {
        XCTAssertEqual(CaretLinePlacement.truncated("see you soon", toWidth: 35, measure: measure), "see…")
    }

    func testNotEvenTheEllipsisFitsIsNil() {
        XCTAssertNil(CaretLinePlacement.truncated("anything", toWidth: 5, measure: measure))
    }

    // MARK: - The alternatives' marks on a capsule

    func testCapsuleMarksUnderlineItsTextAndHangTheTagAfterItsEdge() {
        let capsule = CGRect(x: 360, y: 221, width: 80, height: 24)
        let (layout, caret) = AlternativesLayout.capsule(capsule, area: viewport, padding: 10, verticalPadding: 4, textWidth: 58,
                                                         fontSize: 13, tagWidth: 40, open: true)
        XCTAssertEqual(caret, CGRect(x: 370, y: 225, width: 1, height: 16))
        XCTAssertEqual(layout.underlineWidth, 58)
        XCTAssertTrue(layout.showsTag)
        XCTAssertEqual(layout.tagFrame(caret: caret, width: 40, height: 14)?.minX, capsule.maxX + layout.tagGap)
    }

    func testCapsuleMarksDropTheTagWhereItWouldLeaveTheArea() {
        let capsule = CGRect(x: 880, y: 221, width: 63, height: 24)
        let (layout, _) = AlternativesLayout.capsule(capsule, area: viewport, padding: 10, verticalPadding: 4, textWidth: 41,
                                                     fontSize: 13, tagWidth: 40, open: true)
        XCTAssertFalse(layout.showsTag)
        XCTAssertEqual(layout.textSpan, layout.underlineWidth)
    }
}
