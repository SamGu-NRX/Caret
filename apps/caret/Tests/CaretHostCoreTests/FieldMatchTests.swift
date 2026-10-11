import CaretScreenCore
import CoreGraphics
import XCTest
@testable import CaretHostCore

/// `FieldMatch`: an offer's field against the focused one, by frame and, when both name it, window.
final class FieldMatchTests: XCTestCase {
    private let declared = Frame(x: 200, y: 140, width: 260, height: 22)
    private let focused = CGRect(x: 200, y: 140, width: 260, height: 22)

    private func matches(_ declaredWindow: WindowIdentity?, _ focusedWindow: WindowIdentity?, frame: CGRect? = nil) -> Bool {
        FieldMatch.matches(declaredFrame: declared, declaredWindow: declaredWindow, focusedFrame: frame ?? focused, focusedWindow: focusedWindow)
    }

    func testTwoIdenticalFramesInDifferentWindows() {
        let form = WindowIdentity(number: 41, title: "Contact details")
        let twin = WindowIdentity(number: 42, title: "Contact details")
        XCTAssertTrue(matches(form, form))
        XCTAssertFalse(matches(form, twin), "same frame and title, another window number")
        XCTAssertTrue(matches(nil, twin), "no window named by the offer: the frame decides alone")
        XCTAssertTrue(matches(form, nil), "no window read from the field: the frame decides alone")
    }

    func testTheNumberDecidesBeforeTheTitle() {
        XCTAssertTrue(matches(WindowIdentity(number: 41, title: "Untitled"), WindowIdentity(number: 41, title: "Untitled — Edited")),
                      "a title that changed as the document was edited does not hide the offer")
        XCTAssertFalse(matches(WindowIdentity(number: 41, title: "A"), WindowIdentity(number: nil, title: "B")))
        XCTAssertTrue(matches(WindowIdentity(number: 41, title: "A"), WindowIdentity(number: nil, title: "A")))
        XCTAssertNil(FieldMatch.sameWindow(WindowIdentity(number: 41), WindowIdentity(title: "A")), "nothing in common to compare")
    }

    func testTheFrameMustStillMatch() {
        let form = WindowIdentity(number: 41)
        XCTAssertFalse(matches(form, form, frame: CGRect(x: 200, y: 170, width: 260, height: 22)), "the next field down")
        XCTAssertTrue(matches(form, form, frame: CGRect(x: 200.6, y: 139.4, width: 260, height: 22)), "rounding between readers")
        XCTAssertFalse(FieldMatch.matches(declaredFrame: nil, declaredWindow: form, focusedFrame: focused, focusedWindow: form))
        XCTAssertFalse(FieldMatch.matches(declaredFrame: declared, declaredWindow: form, focusedFrame: nil, focusedWindow: form))
    }
}
