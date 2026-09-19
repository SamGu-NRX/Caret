import XCTest
@testable import Caret

final class TriggerButtonGeometryTests: XCTestCase {
    func testClusterNeverCoversFieldAfterScreenClamping() {
        let screen = CGRect(x: -1200, y: 40, width: 1200, height: 800)
        for field in [
            CGRect(x: -1000, y: 300, width: 500, height: 180),
            CGRect(x: -520, y: 300, width: 500, height: 180),
            CGRect(x: -1195, y: 300, width: 1190, height: 180),
            CGRect(x: -1195, y: 45, width: 1190, height: 180),
            CGRect(x: -1195, y: 650, width: 1190, height: 180),
            CGRect(x: -300, y: 300, width: 0, height: 18)
        ] {
            for width in [CGFloat(40), CGFloat(220)] {
                let frame = TriggerButtonGeometry.frame(avoiding: field, size: CGSize(width: width, height: 40), visibleFrame: screen)
                XCTAssertNotNil(frame)
                if let frame {
                    XCTAssertTrue(screen.contains(frame))
                    XCTAssertFalse(frame.intersects(field.insetBy(dx: -8, dy: -8)))
                }
            }
        }
    }

    func testNoRoomHidesInsteadOfCoveringText() {
        let screen = CGRect(x: 0, y: 0, width: 800, height: 600)
        XCTAssertNil(TriggerButtonGeometry.frame(avoiding: screen, size: CGSize(width: 40, height: 40), visibleFrame: screen))
        XCTAssertNil(TriggerButtonGeometry.frame(avoiding: .zero, size: CGSize(width: 900, height: 40), visibleFrame: screen))
    }
}
