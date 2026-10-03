import CoreGraphics
import XCTest
@testable import CaretHostCore

final class SurfaceGateTests: XCTestCase {
    let caret: Int32 = 1, form: Int32 = 200, messages: Int32 = 300
    let formWindow = CGRect(x: 500, y: 100, width: 520, height: 540)
    let anchor = CGPoint(x: 720, y: 160)

    func check(front: Int32?, focused: Bool = true, windows: [SurfaceGate.Window]) -> SurfaceGate.Hold? {
        SurfaceGate.check(targetPID: form, frontmostPID: front, fieldIsFocused: focused, anchors: [anchor], windows: windows, ownPID: caret)
    }

    func testFrontmostFocusedAndUncoveredDraws() {
        XCTAssertNil(check(front: form, windows: [SurfaceGate.Window(pid: form, bounds: formWindow)]))
    }

    func testABackgroundAppIsHeld() {
        // The 2026-10-02 case: the form's app behind Messages.
        let windows = [SurfaceGate.Window(pid: messages, bounds: CGRect(x: 300, y: 50, width: 900, height: 700)),
                       SurfaceGate.Window(pid: form, bounds: formWindow)]
        XCTAssertEqual(check(front: messages, windows: windows), .appNotFront)
    }

    func testAFrontmostAppWhoseFieldIsNotFocusedIsHeld() {
        XCTAssertEqual(check(front: form, focused: false, windows: [SurfaceGate.Window(pid: form, bounds: formWindow)]), .fieldNotFocused)
    }

    func testAnOccludedAnchorIsHeld() {
        // Frontmost, but another app's floating window sits over the anchor.
        let windows = [SurfaceGate.Window(pid: messages, bounds: CGRect(x: 700, y: 140, width: 200, height: 80), layer: 3),
                       SurfaceGate.Window(pid: form, bounds: formWindow)]
        XCTAssertEqual(check(front: form, windows: windows), .covered)
    }

    func testCaretsOwnPanelsAndInvisibleWindowsDoNotCount() {
        let windows = [SurfaceGate.Window(pid: caret, bounds: CGRect(x: 700, y: 140, width: 200, height: 80), layer: 3),
                       SurfaceGate.Window(pid: messages, bounds: formWindow, alpha: 0),
                       SurfaceGate.Window(pid: form, bounds: formWindow)]
        XCTAssertNil(check(front: form, windows: windows))
    }

    func testAFullScreenOverlayAboveTheNormalLayerIsIgnored() {
        let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let windows = [SurfaceGate.Window(pid: messages, bounds: display, layer: 25),
                       SurfaceGate.Window(pid: form, bounds: formWindow)]
        XCTAssertNil(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [anchor],
                                       windows: windows, ownPID: caret, displays: [display]))
    }

    /// Snipaste's overlay and this Mac's displays as measured on 2026-10-03: the layer-25 window
    /// contains the main display but not the second one below it.
    func testAnOverlayContainingAWholeDisplayIsIgnored() {
        let main = CGRect(x: 0, y: 0, width: 2560, height: 1440), side = CGRect(x: 541, y: 1440, width: 1512, height: 982)
        let overlay = SurfaceGate.Window(pid: messages, bounds: CGRect(x: -1977, y: -1207, width: 5168, height: 3188), layer: 25)
        XCTAssertFalse(overlay.bounds.contains(side), "the measured case: not every display")
        XCTAssertNil(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [anchor],
                                       windows: [overlay, SurfaceGate.Window(pid: form, bounds: formWindow)], ownPID: caret, displays: [main, side]))
        // A floating window that covers only part of a display still covers the field.
        let panel = SurfaceGate.Window(pid: messages, bounds: CGRect(x: 600, y: 100, width: 600, height: 400), layer: 25)
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [anchor],
                                         windows: [panel, SurfaceGate.Window(pid: form, bounds: formWindow)], ownPID: caret, displays: [main, side]), .covered)
    }

    func testAnAnchorOffEveryWindowIsHeld() {
        XCTAssertEqual(check(front: form, windows: [SurfaceGate.Window(pid: form, bounds: CGRect(x: 0, y: 0, width: 10, height: 10))]), .notOnScreen)
    }

    func testGhostTextMustStayInsideTheFieldWithNothingAfterTheCaret() {
        let field = CGRect(x: 710, y: 134, width: 320, height: 24)
        XCTAssertTrue(SurfaceGate.fitsInField(ghost: CGRect(x: 714, y: 138, width: 120, height: 16), field: field, textAfterCaret: false))
        XCTAssertFalse(SurfaceGate.fitsInField(ghost: CGRect(x: 714, y: 138, width: 400, height: 16), field: field, textAfterCaret: false), "runs past the field")
        XCTAssertFalse(SurfaceGate.fitsInField(ghost: CGRect(x: 714, y: 138, width: 120, height: 16), field: field, textAfterCaret: true), "would cover text after the caret")
    }

    func testTheListGoesBelowUnlessThatCoversAField() {
        let bounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let below = CGRect(x: 700, y: 170, width: 300, height: 90), above = CGRect(x: 700, y: 30, width: 300, height: 90)
        XCTAssertEqual(PanelPlacement.choose([below, above], obstacles: [], bounds: bounds).index, 0)
        let next = CGRect(x: 710, y: 186, width: 320, height: 24)
        XCTAssertEqual(PanelPlacement.choose([below, above], obstacles: [next], bounds: bounds).index, 1, "flips above when below covers a field")
    }
}
