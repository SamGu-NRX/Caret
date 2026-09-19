import XCTest
@testable import CaretCore

final class NearbyTextWindowTests: XCTestCase {
    func testShortValueIsSentWholeAtOffsetZero() {
        let value = "I will send the "
        guard case .success(let window) = NearbyTextWindow.around(
            value: value,
            caret: 16,
            selection: TextSelection(start: 16, end: 16)
        ) else { return XCTFail("expected a window") }

        XCTAssertEqual(window.offset, 0)
        XCTAssertEqual(window.text, value)
        XCTAssertEqual(window.end, 16)
    }

    func testWindowIsBoundedAndStillContainsTheCaret() {
        let value = String(repeating: "a", count: 10_000)
        let caret = 9_000
        guard case .success(let window) = NearbyTextWindow.around(
            value: value,
            caret: caret,
            selection: TextSelection(start: caret, end: caret),
            limit: CoreLimits.nearbyTextUnits
        ) else { return XCTFail("expected a window") }

        XCTAssertEqual(window.length, CoreLimits.nearbyTextUnits)
        XCTAssertLessThanOrEqual(window.offset, caret)
        XCTAssertLessThanOrEqual(caret, window.end)
    }

    func testWindowContainsTheWholeSelection() {
        let value = String(repeating: "b", count: 10_000)
        let selection = TextSelection(start: 5_000, end: 5_600)
        guard case .success(let window) = NearbyTextWindow.around(
            value: value,
            caret: selection.end,
            selection: selection
        ) else { return XCTFail("expected a window") }

        XCTAssertLessThanOrEqual(window.offset, selection.start)
        XCTAssertLessThanOrEqual(selection.end, window.end)
        XCTAssertLessThanOrEqual(window.length, CoreLimits.nearbyTextUnits)
    }

    func testSelectionLargerThanTheBoundIsRefusedRatherThanTruncated() {
        let value = String(repeating: "c", count: 10_000)
        let selection = TextSelection(start: 0, end: 5_000)
        guard case .failure(let failure) = NearbyTextWindow.around(
            value: value,
            caret: 5_000,
            selection: selection
        ) else { return XCTFail("expected a refusal") }

        XCTAssertEqual(failure, .selectionExceedsLimit(units: 5_000, limit: CoreLimits.nearbyTextUnits))
    }

    func testCaretPastTheValueIsRefused() {
        guard case .failure(let failure) = NearbyTextWindow.around(
            value: "short",
            caret: 99,
            selection: TextSelection(start: 99, end: 99)
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(failure, .caretOutsideValue)
    }

    // MARK: - UTF-16 arithmetic

    func testLengthCountsUTF16UnitsNotCharacters() {
        // One emoji is a surrogate pair: two UTF-16 units, one Character.
        XCTAssertEqual(UTF16Text.length("👋"), 2)
        XCTAssertEqual("👋".count, 1)
        XCTAssertEqual(UTF16Text.length("hi 👋"), 5)
    }

    func testSliceRefusesToSplitASurrogatePair() {
        let value = "hi 👋 there"
        XCTAssertEqual(UTF16Text.slice(value, start: 0, end: 3), "hi ")
        XCTAssertEqual(UTF16Text.slice(value, start: 3, end: 5), "👋")
        // Halfway into the pair.
        XCTAssertNil(UTF16Text.slice(value, start: 0, end: 4))
        XCTAssertNil(UTF16Text.slice(value, start: 4, end: 6))
    }

    func testSliceRefusesAnOutOfRangeOrInvertedRange() {
        XCTAssertNil(UTF16Text.slice("abc", start: 0, end: 9))
        XCTAssertNil(UTF16Text.slice("abc", start: 2, end: 1))
        XCTAssertNil(UTF16Text.slice("abc", start: -1, end: 2))
    }

    func testWindowBoundaryNeverSplitsASurrogatePair() {
        // Emoji at every position, so an arbitrary bound lands mid-pair often.
        let value = String(repeating: "👋", count: 3_000) // 6,000 UTF-16 units
        for caret in stride(from: 0, to: 6_000, by: 997) {
            let aligned = caret - (caret % 2)
            guard case .success(let window) = NearbyTextWindow.around(
                value: value,
                caret: aligned,
                selection: TextSelection(start: aligned, end: aligned)
            ) else { return XCTFail("expected a window at \(aligned)") }

            XCTAssertEqual(window.offset % 2, 0, "window split a surrogate pair at caret \(aligned)")
            XCTAssertLessThanOrEqual(window.length, CoreLimits.nearbyTextUnits)
            XCTAssertLessThanOrEqual(window.offset, aligned)
            XCTAssertLessThanOrEqual(aligned, window.end)
            // The window must be a real slice of the value at its offset.
            XCTAssertEqual(UTF16Text.slice(value, start: window.offset, end: window.end), window.text)
        }
    }

    func testDigestMatchesTheCoreFormat() {
        // SHA-256 of "" is e3b0c442..., truncated to 16 hex characters.
        XCTAssertEqual(UTF16Text.digest(""), "e3b0c44298fc1c14")
        XCTAssertEqual(UTF16Text.digest("abc"), "ba7816bf8f01cfea")
        XCTAssertEqual(UTF16Text.digest("abc").count, 16)
    }
}
