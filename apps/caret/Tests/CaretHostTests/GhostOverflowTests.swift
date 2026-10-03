import AppKit
import AutocompleteCore
import CaretHostCore
import CompletionUI
import XCTest
@testable import CaretHost

/// A9's Promo code run: 54 keys of "Please send the meeting notes to the team before lunch" into a
/// 320 pt single-line field, 38 of 76 offers with no placement. Once the sentence reaches the
/// field's right edge, KeyType's renderer declines every completion as too wide for its line.
@MainActor
final class GhostOverflowTests: XCTestCase {
    /// The field in AppKit coordinates (KeyType's space), 13 pt system text.
    private let field = CGRect(x: 710, y: 122, width: 320, height: 24)
    private let font = NSFont.systemFont(ofSize: 13)

    private func placement(caretX: CGFloat) -> OverlayPlacement {
        OverlayPlacement(cursorRect: CGRect(x: caretX, y: 124, width: 1, height: 18), fieldRect: field, cursorRectQuality: .exact)
    }

    private func caretX(after typed: String) -> CGFloat {
        min(field.minX + 4 + (typed as NSString).size(withAttributes: [.font: font]).width, field.maxX - 3)
    }

    func testEarlyInTheSentenceACompletionFitsOnTheLine() {
        let p = placement(caretX: caretX(after: "Please send the"))
        XCTAssertEqual(GhostOverlay.decision(" meeting notes", font: font, placement: p, canMirror: false, rule: .capsule), .asPlaced)
    }

    func testAtTheFieldsEdgeKeyTypeDeclinesAndCaretUsesTheCapsule() {
        let p = placement(caretX: caretX(after: "Please send the meeting notes to the team before"))
        XCTAssertTrue(GhostTextOverlayWindow.shouldSuppressInlineSingleLineOverflow(text: " lunch", font: font, placement: p),
                      "KeyType's own test is the A9 cause")
        XCTAssertEqual(GhostOverlay.decision(" lunch", font: font, placement: p, canMirror: false, rule: .drop), .decline(.singleLineOverflow))
        XCTAssertEqual(GhostOverlay.decision(" lunch", font: font, placement: p, canMirror: false, rule: .capsule), .capsule)
    }

    func testTheCapsuleIsNotDeclinedByTheInlineOverflowTest() {
        var p = placement(caretX: field.maxX - 3)
        p.presentation = .capsule
        XCTAssertFalse(GhostTextOverlayWindow.shouldSuppressInlineSingleLineOverflow(text: " before lunch today", font: font, placement: p))
        XCTAssertFalse(GhostTextOverlayWindow.shouldSuppressMirrorOverflow(text: " before lunch today", font: font, placement: p))
    }
}

@MainActor
final class GhostCapsuleScreenTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 2560, height: 1415)
    private let font = NSFont.systemFont(ofSize: 13)

    private func placement(caretY: CGFloat) -> OverlayPlacement {
        var p = OverlayPlacement(cursorRect: CGRect(x: 900, y: caretY, width: 1, height: 18),
                                 fieldRect: CGRect(x: 710, y: caretY - 3, width: 320, height: 24), cursorRectQuality: .exact)
        p.presentation = .capsule
        return p
    }

    func testACapsuleWithRoomBelowTheCaretFits() {
        XCTAssertTrue(GhostOverlay.capsuleFitsOnScreen(placement: placement(caretY: 120), font: font, screens: [screen]))
    }

    func testACapsuleThatWouldHangOffTheDisplayIsRefused() {
        // AppKit coordinates: a caret 10 pt above the bottom edge leaves no room for the capsule.
        XCTAssertFalse(GhostOverlay.capsuleFitsOnScreen(placement: placement(caretY: 10), font: font, screens: [screen]))
    }

    func testACaretOnNoDisplayIsRefused() {
        XCTAssertFalse(GhostOverlay.capsuleFitsOnScreen(placement: placement(caretY: 3000), font: font, screens: [screen]))
    }
}
