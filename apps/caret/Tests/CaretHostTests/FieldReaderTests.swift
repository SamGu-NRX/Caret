import ApplicationServices
import XCTest
@testable import CaretHost

/// The Catalyst sample: an empty UITextView answers AXValue with kAXErrorNoValue and a character count of 0.
final class FieldReaderTests: XCTestCase {
    func testAValueReadIsKept() {
        XCTAssertEqual(FieldReader.emptyOrValue("Thanks", error: .success, characterCount: nil), "Thanks")
    }

    func testNoValueWithNoCharactersIsAnEmptyField() {
        XCTAssertEqual(FieldReader.emptyOrValue(nil, error: .noValue, characterCount: 0), "")
    }

    func testNoValueWithCharactersOrNoCountStaysUnreadable() {
        XCTAssertNil(FieldReader.emptyOrValue(nil, error: .noValue, characterCount: 12))
        XCTAssertNil(FieldReader.emptyOrValue(nil, error: .noValue, characterCount: nil))
    }

    func testOtherErrorsStayUnreadable() {
        XCTAssertNil(FieldReader.emptyOrValue(nil, error: .attributeUnsupported, characterCount: 0))
        XCTAssertNil(FieldReader.emptyOrValue(nil, error: .cannotComplete, characterCount: 0))
    }
}
