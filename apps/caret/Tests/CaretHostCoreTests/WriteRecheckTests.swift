import XCTest
@testable import CaretHostCore

/// PR #13 Apex review (beta.2 blocker): between a guard's approval and the write it approved, an insert and
/// Caret's ordinary Undo checked only that the claim was live and the process and focus the same. Input since
/// the key, and the field's value and selection after the selection was set, were not checked.
final class WriteRecheckTests: XCTestCase {
    struct Mark: Equatable { var keys: UInt64; var clicks: UInt64 }

    func testInputSinceTheKeyRefusesTheWrite() {
        XCTAssertNil(WriteRecheck.input(atKey: Mark(keys: 4, clicks: 1), now: Mark(keys: 4, clicks: 1)))
        XCTAssertEqual(WriteRecheck.input(atKey: Mark(keys: 4, clicks: 1), now: Mark(keys: 5, clicks: 1)), .inputMoved, "a key")
        XCTAssertEqual(WriteRecheck.input(atKey: Mark(keys: 4, clicks: 1), now: Mark(keys: 4, clicks: 2)), .inputMoved, "a click")
    }

    let value = "Thanks for the notes"
    var range: UTF16Selection { .caret(20) }

    func testTheSelectedFieldMustBeExactlyTheApprovedOne() {
        XCTAssertNil(WriteRecheck.selected(value: value, selection: range, sameElement: true, expectedValue: value, range: range))
    }

    func testAChangedValueRefuses() {
        XCTAssertEqual(WriteRecheck.selected(value: value + "s", selection: .caret(21), sameElement: true, expectedValue: value, range: range), .fieldChanged)
        XCTAssertEqual(WriteRecheck.selected(value: nil, selection: nil, sameElement: true, expectedValue: value, range: range), .fieldChanged, "unreadable")
    }

    func testASelectionThatIsNotTheRangeRefuses() {
        XCTAssertEqual(WriteRecheck.selected(value: value, selection: .caret(6), sameElement: true, expectedValue: value, range: range), .selectionMoved)
        XCTAssertEqual(WriteRecheck.selected(value: value, selection: UTF16Selection(start: 0, end: 20), sameElement: true, expectedValue: value, range: range),
                       .selectionMoved, "a selection made since would turn an insert into a replacement")
        XCTAssertEqual(WriteRecheck.selected(value: value, selection: nil, sameElement: true, expectedValue: value, range: range), .selectionMoved)
    }

    func testAnotherElementRefuses() {
        XCTAssertEqual(WriteRecheck.selected(value: value, selection: range, sameElement: false, expectedValue: value, range: range), .targetMoved)
    }

    /// The value after a write that is neither the one before it nor the one predicted is an edit Caret made in
    /// the wrong place: it is reported, never left silent.
    func testALandedWriteThatIsNotThePredictedOneIsMisplaced() {
        XCTAssertEqual(WriteRecheck.landed(value: "ab", before: "a", expected: "ab"), .applied)
        XCTAssertEqual(WriteRecheck.landed(value: "a", before: "a", expected: "ab"), .untouched)
        XCTAssertEqual(WriteRecheck.landed(value: "ba", before: "a", expected: "ab"), .misplaced)
        XCTAssertEqual(WriteRecheck.landed(value: nil, before: "a", expected: "ab"), .unknown)
    }
}
