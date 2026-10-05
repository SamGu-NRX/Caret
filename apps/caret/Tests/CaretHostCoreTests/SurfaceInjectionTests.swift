import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The debug socket's `inject` payload (`SurfaceInjection.decode`).
final class SurfaceInjectionTests: XCTestCase {
    private func decode(_ json: String) throws -> SurfaceInjection {
        try SurfaceInjection.decode(Data(json.utf8))
    }

    /// CodeRabbit on PR #8: a pid past Int32.max trapped in Int32(_:) and took the host down.
    func testAPidThatIsNotAPositiveInt32IsRefusedNotTrapped() {
        for pid in ["1e10", "2147483648", "-1", "0", "1.5"] {
            XCTAssertThrowsError(try decode(#"{"kind":"alternatives","pid":\#(pid),"candidates":["a"]}"#), pid) { error in
                XCTAssertEqual((error as? SurfaceInjection.Invalid)?.description, "needs a pid", pid)
            }
        }
        XCTAssertNoThrow(try decode(#"{"kind":"alternatives","pid":2147483647,"candidates":["a"]}"#))
    }
}
