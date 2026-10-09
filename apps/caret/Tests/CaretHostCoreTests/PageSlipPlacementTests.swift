import CaretHostCore
import CoreGraphics
import XCTest

/// The offer slip at a web form's field, from the DF1 VM run (job caret-df1-2d8af14-n1, run 20261009T044644Z-88912,
/// out/fill.json): First Name's field at [128.5, 217, 680, 32], the slip 298 x 30, which the host put below at y 255 with
/// nothing found under it, over Last Name's label. The other rows are read from that run's browser capture (48 px for
/// the field's 32 pt): each label's text 15 pt tall, 21 pt over its field, fields 70 pt apart, all 680 wide at x 128.5.
/// The guest's display is 960 x 600 pt with a 25 pt menu bar.
final class PageSlipPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 25, width: 960, height: 575)
    let slip = CGSize(width: 298, height: 30)

    func field(_ row: Int) -> CGRect { CGRect(x: 128.5, y: 217 + CGFloat(row) * 70, width: 680, height: 32) }
    /// A label's text, as the page measures it (a Range over the label's text, not the label element's box).
    func label(_ row: Int, width: CGFloat = 96) -> CGRect { CGRect(x: 128.5, y: field(row).minY - 21, width: width, height: 15) }
    func caret(_ row: Int) -> CGRect { CGRect(x: field(row).minX + 8, y: field(row).minY + 7, width: 1, height: 18) }

    /// What the page reports near the focused row: every other field and every label, its own label included.
    func nearby(_ row: Int) -> [CGRect] {
        (0..<5).filter { $0 != row }.map(field) + (0..<5).map { label($0) }
    }

    func place(_ row: Int) -> FieldPanelPlacement.Choice {
        let page = nearby(row)
        return FieldPanelPlacement.choose(
            field: field(row), caret: caret(row), size: slip, narrow: nil, bounds: screen, sideFirst: true,
            obstacles: { frame in page.filter { $0.intersects(frame) } }
        )
    }

    func testTheRecordedSpotCoveredLastNamesLabel() {
        let recorded = CGRect(x: 117.5, y: 255, width: 298, height: 30)
        XCTAssertTrue(recorded.intersects(label(1)), "the screenshot's overlap, from the recorded frames")
    }

    func testAtFirstNameTheSlipCoversNoOtherFieldOrLabel() {
        let choice = place(0)
        XCTAssertEqual(choice.overlap, 0)
        for item in nearby(0) { XCTAssertFalse(item.intersects(choice.frame), "covers \(item)") }
        XCTAssertFalse(choice.frame.intersects(field(0)), "never over the field it is about")
        XCTAssertTrue(screen.insetBy(dx: FieldPanelPlacement.margin, dy: FieldPanelPlacement.margin).contains(choice.frame))
    }

    func testFullWidthFieldsLeaveNoRoomBesideSoItGoesAboveAtTheFieldsEnd() {
        // 680 pt fields from x 128.5 leave 151 pt to the right and 128 to the left: too narrow for the slip.
        let choice = place(0)
        XCTAssertEqual(choice.spot, .aboveEnd)
        XCTAssertEqual(choice.frame.maxX, field(0).maxX)
    }

    func testEveryRowOfTheFormGetsAClearSpot() {
        for row in 0..<5 {
            let choice = place(row)
            XCTAssertEqual(choice.overlap, 0, "row \(row): \(choice.spot)")
            for item in nearby(row) { XCTAssertFalse(item.intersects(choice.frame), "row \(row) covers \(item)") }
        }
    }

    func testANarrowFieldTakesTheRoomBesideIt() {
        let narrow = CGRect(x: 128.5, y: 217, width: 320, height: 32)
        let page = (1..<5).map(field) + (0..<5).map { label($0) }
        let choice = FieldPanelPlacement.choose(
            field: narrow, caret: caret(0), size: slip, narrow: nil, bounds: screen, sideFirst: true,
            obstacles: { frame in page.filter { $0.intersects(frame) } }
        )
        XCTAssertEqual(choice.spot, .right, "beside the field first when there is room")
        XCTAssertEqual(choice.overlap, 0)
    }

    func testNativePlacementKeepsBelowFirst() {
        let list = FieldPanelPlacement.candidates(field: field(0), caret: caret(0), size: slip, narrow: nil, bounds: screen)
        XCTAssertEqual(list.first?.0, .below)
        let side = FieldPanelPlacement.candidates(field: field(0), caret: caret(0), size: slip, narrow: nil, bounds: screen, sideFirst: true)
        XCTAssertEqual(side.first?.0, .right)
    }
}
