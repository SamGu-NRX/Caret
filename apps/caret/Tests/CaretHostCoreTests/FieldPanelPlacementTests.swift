import CaretHostCore
import CoreGraphics
import XCTest

/// The claim form as A9 measured it on a 2560 x 1440 display: the window at [540, 824, 520, 536],
/// fields 320 x 24 at x 710 every 52 pt, labels at x 558, a 28 pt title bar.
final class FieldPanelPlacementTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 25, width: 2560, height: 1415)
    private let card = CGSize(width: 240, height: 170)

    private func form(windowX: CGFloat = 540, windowY: CGFloat = 824) -> (fields: [CGRect], labels: [CGRect], titleBar: CGRect) {
        let fields = (0..<9).map { CGRect(x: windowX + 170, y: windowY + 54 + CGFloat($0) * 52, width: 320, height: 24) }
        // Row 3 (the unlabelled one under Phone) and row 7 (Website) have no label.
        let labels = fields.enumerated().filter { ![3, 7].contains($0.offset) }.map { CGRect(x: windowX + 18, y: $0.element.minY + 3, width: 110, height: 18) }
        return (fields, labels, CGRect(x: windowX, y: windowY, width: 520, height: 28))
    }

    private final class Calls { var count = 0 }

    /// What `ObstacleProbe` would find: every element of the form under the frame.
    private func probe(_ items: [CGRect], calls: Calls? = nil) -> (CGRect) -> [CGRect] {
        { frame in
            calls?.count += 1
            return items.filter { $0.intersects(frame) }
        }
    }

    private func caret(in field: CGRect) -> CGRect { CGRect(x: field.minX + 4, y: field.minY + 3, width: 1, height: 18) }

    private func assertCoversNothing(_ choice: FieldPanelPlacement.Choice, _ items: [CGRect], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(choice.overlap, 0, file: file, line: line)
        for item in items { XCTAssertFalse(item.intersects(choice.frame), "covers \(item)", file: file, line: line) }
    }

    func testTheCardAtPhoneGoesBesideTheFieldWhenBelowAndAboveCoverFields() {
        let f = form()
        let phone = f.fields[2]
        let others = f.fields.filter { $0 != phone } + f.labels + [f.titleBar]
        let choice = FieldPanelPlacement.choose(field: phone, caret: caret(in: phone), size: card, narrow: nil, bounds: screen, obstacles: probe(others))
        XCTAssertEqual(choice.spot, .right)
        XCTAssertEqual(choice.frame.minX, phone.maxX + 6)
        XCTAssertEqual(choice.frame.minY, phone.minY, "top-aligned with the field")
        assertCoversNothing(choice, others + [phone])
    }

    func testBelowWinsWhereThereIsRoom() {
        // Higher on the screen than A9's window, so the card fits under Promo code.
        let f = form(windowY: 300)
        let promo = f.fields[8]
        let others = f.fields.filter { $0 != promo } + f.labels + [f.titleBar]
        let choice = FieldPanelPlacement.choose(field: promo, caret: caret(in: promo), size: card, narrow: nil, bounds: screen, obstacles: probe(others))
        XCTAssertEqual(choice.spot, .below)
        XCTAssertEqual(choice.frame.minY, promo.maxY + 6, "6 pt under the field, not the caret")
        XCTAssertEqual(choice.frame.minX, promo.minX + 4 - 12, "12 pt left of the caret")
        assertCoversNothing(choice, others)
    }

    func testItFlipsAboveWhenBelowIsOffScreen() {
        let field = CGRect(x: 710, y: 1380, width: 320, height: 24)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: card, narrow: nil, bounds: screen, obstacles: probe([]))
        XCTAssertEqual(choice.spot, .above)
        XCTAssertEqual(choice.frame.maxY, field.minY - 6)
        XCTAssertEqual(choice.spot.corner, .bottomLeft, "grows upward, away from the field")
    }

    func testItNarrowsWhenOnlyTheRightEndWouldCoverANeighbour() {
        // Two columns: a field to the lower right of the focused one.
        let field = CGRect(x: 400, y: 400, width: 200, height: 24)
        let neighbour = CGRect(x: 660, y: 440, width: 200, height: 24)
        let above = CGRect(x: 380, y: 200, width: 500, height: 190)
        let wide = CGSize(width: 340, height: 120), narrow = CGSize(width: 240, height: 150)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: wide, narrow: narrow, bounds: screen,
                                                obstacles: probe([neighbour, above]))
        XCTAssertEqual(choice.spot, .belowNarrow)
        XCTAssertEqual(choice.frame.size, narrow)
        assertCoversNothing(choice, [neighbour, above])
    }

    func testWithNoRoomAnywhereTheLeastCoveringSpotWinsAndSaysSo() {
        // The window against the screen's right edge: nothing to the right, labels to the left.
        let f = form(windowX: 2560 - 520)
        let phone = f.fields[2]
        let others = f.fields.filter { $0 != phone } + f.labels + [f.titleBar]
        let choice = FieldPanelPlacement.choose(field: phone, caret: caret(in: phone), size: card, narrow: nil, bounds: screen, obstacles: probe(others))
        let all = FieldPanelPlacement.candidates(field: phone, caret: caret(in: phone), size: card, narrow: nil, bounds: screen)
            .filter { screen.insetBy(dx: 8, dy: 8).contains($0.1) }
        let overlaps = all.map { _, frame in others.reduce(CGFloat(0)) { s, o in let i = o.intersection(frame); return i.isNull ? s : s + i.width * i.height } }
        XCTAssertGreaterThan(try XCTUnwrap(choice.overlap), 0, "it reports the overlap it could not avoid")
        XCTAssertEqual(choice.overlap, overlaps.min())
        XCTAssertFalse(choice.frame.intersects(phone))
    }

    func testTheProbeIsAskedOnlyAsFarAsNeeded() {
        let calls = Calls()
        let field = CGRect(x: 710, y: 400, width: 320, height: 24)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: card, narrow: nil, bounds: screen, obstacles: probe([], calls: calls))
        XCTAssertEqual(choice.spot, .below)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(choice.probed, 1)
    }

    func testTheFieldAndWhatContainsItAreNeverObstacles() {
        let field = CGRect(x: 710, y: 400, width: 320, height: 24)
        let group = CGRect(x: 600, y: 300, width: 600, height: 500)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: card, narrow: nil, bounds: screen,
                                                obstacles: { _ in [field, group] })
        XCTAssertEqual(choice.spot, .below)
        XCTAssertEqual(choice.overlap, 0)
    }

    func testInATallFieldThePanelHangsFromTheCaretsLine() {
        let textView = CGRect(x: 100, y: 100, width: 800, height: 600)
        let caret = CGRect(x: 300, y: 340, width: 1, height: 17)
        XCTAssertEqual(FieldPanelPlacement.anchor(field: textView, caret: caret), CGRect(x: 100, y: 340, width: 800, height: 17))
        let choice = FieldPanelPlacement.choose(field: textView, caret: caret, size: card, narrow: nil, bounds: screen, obstacles: probe([]))
        XCTAssertEqual(choice.spot, .below)
        XCTAssertEqual(choice.frame.minY, caret.maxY + 6)
    }

    func testOffEveryEdgeItFallsBackBelowWithNothingMeasured() {
        let tiny = CGRect(x: 0, y: 0, width: 200, height: 100)
        let field = CGRect(x: 20, y: 40, width: 150, height: 24)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: card, narrow: nil, bounds: tiny, obstacles: probe([]))
        XCTAssertEqual(choice.spot, .below)
        XCTAssertNil(choice.overlap)
        XCTAssertEqual(choice.probed, 0)
    }

    func testTheFallbackIsClampedOntoTheScreenWhereItFits() {
        // Too wide for any spot, short enough to fit vertically: below would run off the bottom.
        let short = CGRect(x: 0, y: 0, width: 300, height: 200)
        let field = CGRect(x: 20, y: 150, width: 150, height: 24)
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: CGSize(width: 400, height: 60), narrow: nil,
                                                bounds: short, obstacles: probe([]))
        XCTAssertNil(choice.overlap)
        XCTAssertLessThanOrEqual(choice.frame.maxY, short.maxY - 8)
    }

    func testASpotThatCouldNotBeProbedInTimeIsNeverTaken() {
        let field = CGRect(x: 710, y: 400, width: 320, height: 24)
        var asked = 0
        let choice = FieldPanelPlacement.choose(field: field, caret: caret(in: field), size: card, narrow: nil, bounds: screen,
                                                obstacles: { _ in asked += 1; return asked == 1 ? nil : [] })
        XCTAssertEqual(choice.spot, .above, "below was not probed in time, so it is not clear")
        XCTAssertEqual(choice.overlap, 0)
    }

    func testEachSpotPinsTheCornerNearestTheField() {
        let choice = FieldPanelPlacement.Choice(frame: CGRect(x: 10, y: 20, width: 100, height: 50), spot: .left, overlap: 0, probed: 1)
        XCTAssertEqual(choice.cornerPoint, CGPoint(x: 110, y: 20))
        XCTAssertEqual(FieldPanelPlacement.Spot.right.corner, .topLeft)
        XCTAssertEqual(FieldPanelPlacement.Spot.aboveNarrow.corner, .bottomLeft)
    }
}
