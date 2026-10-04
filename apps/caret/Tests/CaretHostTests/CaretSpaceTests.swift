import AutocompleteCore
import CaretHostCore
import CoreGraphics
import MacContextCapture
import XCTest
@testable import CaretHost

/// KeyType's caret rect is in AppKit coordinates; the gate, the surfaces and the perch read
/// Accessibility coordinates. A9 found the gate given the AppKit rect unconverted.
final class CaretSpaceTests: XCTestCase {
    /// A9's measured layout on a 2560 x 1440 main display: the fixture's Promo code field at
    /// Accessibility [710, 1294, 320, 24], the fixture window over it, and another app's window
    /// over the point mirrored across the display (y 134).
    private let primaryHeight: CGFloat = 1440
    private let fixture: Int32 = 18699
    private let other: Int32 = 42162
    private var windows: [SurfaceGate.Window] {
        [
            SurfaceGate.Window(pid: fixture, bounds: CGRect(x: 540, y: 824, width: 520, height: 536), layer: 0, alpha: 1),
            SurfaceGate.Window(pid: other, bounds: CGRect(x: 524, y: 30, width: 1512, height: 902), layer: 0, alpha: 1),
        ]
    }

    func testTheCaretIsConvertedToTheFieldsOwnSpace() {
        let field = CGRect(x: 710, y: 1294, width: 320, height: 24)
        // The resolver's AppKit rect for a caret 40 pt into that field.
        let appKit = CGRect(x: 750, y: primaryHeight - 1294 - 22, width: 2, height: 20)
        let ax = Screen.ax(appKit, primaryHeight: primaryHeight)
        XCTAssertEqual(ax, CGRect(x: 750, y: 1296, width: 2, height: 20))
        XCTAssertTrue(field.contains(CGPoint(x: ax.midX, y: ax.midY)), "the converted caret is inside the field")
    }

    func testTheGateSeesTheFixtureAtTheConvertedCaretAndAnotherAppAtTheRawOne() {
        let appKit = CGRect(x: 750, y: primaryHeight - 1294 - 22, width: 2, height: 20)
        let ax = Screen.ax(appKit, primaryHeight: primaryHeight)
        func hold(_ r: CGRect) -> SurfaceGate.Hold? {
            SurfaceGate.check(targetPID: fixture, frontmostPID: fixture, fieldIsFocused: true,
                              anchors: [CGPoint(x: r.midX, y: r.midY)], windows: windows, ownPID: 1)
        }
        XCTAssertNil(hold(ax), "converted: the fixture's own window is on top")
        XCTAssertEqual(hold(appKit), .covered, "unconverted, as before A9: another app's window")
    }

    func testTheSnapshotsAccessibilityCaretIsItsCaretRectConverted() {
        let context = TextFieldContext(beforeCursor: "Please", afterCursor: "", geometry: TextFieldGeometry(isAtEndOfLine: true),
                                       target: AppTarget(bundleIdentifier: "b", appName: "B"))
        let appKit = CGRect(x: 750, y: 124, width: 2, height: 20)
        let snapshot = FocusedFieldSnapshot(context: context, caretRect: appKit, caretSource: nil, caretQuality: nil)
        XCTAssertEqual(snapshot.caretRectAX, Screen.ax(appKit))
        XCTAssertNil(FocusedFieldSnapshot(context: context, caretRect: nil, caretSource: nil, caretQuality: nil).caretRectAX)
    }
}
