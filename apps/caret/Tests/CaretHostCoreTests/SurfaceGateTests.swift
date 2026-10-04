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

    /// Measured on 2026-10-03 (A12 desktop run): Grammarly Desktop's window at layer 1 over
    /// TextEdit's focused text area, the area grown by 64 pt on every side.
    func testAWritingAidsWindowDrawnAroundTheFieldIsIgnored() {
        let field = CGRect(x: 309, y: 203, width: 586, height: 382)
        let point = CGPoint(x: field.midX, y: field.midY)
        let windows = [
            SurfaceGate.Window(pid: 1487, bounds: CGRect(x: 245, y: 139, width: 714, height: 510), layer: 1, agent: true),
            SurfaceGate.Window(pid: form, bounds: CGRect(x: 309, y: 103, width: 603, height: 505)),
        ]
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [point], windows: windows, ownPID: caret, field: field), nil)
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [point], windows: windows, ownPID: caret), .covered,
                       "without the field's frame the gate cannot tell, and holds")
        var regular = windows
        regular[0].agent = false
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [point], windows: regular, ownPID: caret, field: field), .covered,
                       "a regular app's window ringing the field may be an opaque palette: it covers")
        let moved = field.offsetBy(dx: 2, dy: 0)
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [point], windows: windows, ownPID: caret, field: moved), .covered,
                       "a ring measured against a frame the field no longer has does not match, so the gate reads the frame live")
    }

    func testOnlyAnEvenRingAroundTheFieldCounts() {
        let field = CGRect(x: 309, y: 203, width: 586, height: 382)
        XCTAssertTrue(SurfaceGate.ringsField(field.insetBy(dx: -64, dy: -64), field))
        XCTAssertTrue(SurfaceGate.ringsField(field, field), "a window exactly over the field")
        XCTAssertTrue(SurfaceGate.ringsField(field.insetBy(dx: -96, dy: -96), field))
        XCTAssertFalse(SurfaceGate.ringsField(field.insetBy(dx: -97, dy: -97), field), "past the largest margin")
        XCTAssertFalse(SurfaceGate.ringsField(CGRect(x: 245, y: 139, width: 714, height: 300), field), "a palette over part of the field")
        XCTAssertFalse(SurfaceGate.ringsField(CGRect(x: 300, y: 150, width: 700, height: 500), field), "uneven margins: not drawn around it")
        XCTAssertFalse(SurfaceGate.ringsField(field.insetBy(dx: 10, dy: 10), field), "inside the field")
    }

    func testANormalLayerWindowRingingTheFieldStillCovers() {
        // Only elevated windows can be decorations; a document window that happens to sit evenly
        // around the field is another app's window over it.
        let field = CGRect(x: 600, y: 140, width: 200, height: 40)
        let windows = [SurfaceGate.Window(pid: messages, bounds: field.insetBy(dx: -20, dy: -20), agent: true), SurfaceGate.Window(pid: form, bounds: formWindow)]
        XCTAssertEqual(SurfaceGate.check(targetPID: form, frontmostPID: form, fieldIsFocused: true, anchors: [CGPoint(x: 700, y: 160)], windows: windows, ownPID: caret, field: field), .covered)
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
}
