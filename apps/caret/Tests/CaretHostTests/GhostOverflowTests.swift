import AppKit
import AutocompleteCore
import CaretHostCore
@testable import CompletionUI
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

/// A18, bug 6: Q1's capsule drew past TextEdit's right edge, over other apps. The capsule now stays
/// inside the focused window, or is not drawn.
@MainActor
final class GhostCapsuleWindowTests: XCTestCase {
    private let font = NSFont.systemFont(ofSize: 13)
    /// A TextEdit window in AppKit coordinates, and its text view, as wide as the document.
    private let window = CGRect(x: 100, y: 200, width: 700, height: 500)
    private let view = CGRect(x: 100, y: 200, width: 900, height: 470)

    private func capsule(caretX: CGFloat, field: CGRect?) -> OverlayPlacement {
        var p = OverlayPlacement(cursorRect: CGRect(x: caretX, y: 500, width: 1, height: 16), fieldRect: field, cursorRectQuality: .exact)
        p.presentation = .capsule
        return p
    }

    func testTheCopiedLayoutMatchesKeyTypes() {
        for (x, field) in [(400.0, view), (790.0, view), (790.0, window), (150.0, CGRect?.none)] as [(CGFloat, CGRect?)] {
            for text in [" could be", " in section two of the draft"] {
                let p = capsule(caretX: x, field: field)
                let width = (text as NSString).size(withAttributes: [.font: font]).width
                let ours = GhostFit.capsuleFrame(caret: p.cursorRect, field: p.fieldRect, textWidth: width,
                                                 fontLineHeight: ceil(font.ascender - font.descender), approximateCaret: false)
                let theirs = GhostTextOverlayWindow.layout(for: text, font: font, placement: p)
                XCTAssertEqual(ours.frame, theirs.frame, "\(text) at \(x)")
                XCTAssertEqual(ours.lineHeight, theirs.lineHeight)
            }
        }
    }

    func testNearTheWindowsRightEdgeTheCapsuleSlidesInside() {
        var p = capsule(caretX: 790, field: view)
        XCTAssertNil(GhostOverlay.keepCapsuleInWindow(&p, text: " in section two", font: font, window: window, pid: nil).cause)
        XCTAssertEqual(p.fieldRect, window.intersection(view))
        let frame = GhostTextOverlayWindow.layout(for: " in section two", font: font, placement: p).frame
        XCTAssertTrue(window.contains(frame), "KeyType's own layout now lies in the window: \(frame)")
    }

    func testACapsuleWiderThanTheWindowIsNotDrawn() {
        let narrow = CGRect(x: 100, y: 200, width: 120, height: 500)
        var p = capsule(caretX: 180, field: narrow)
        XCTAssertEqual(GhostOverlay.keepCapsuleInWindow(&p, text: " in section two of the draft", font: font, window: narrow, pid: nil).cause, .capsuleOutsideWindow)
    }

    func testOnTheWindowsLastLineTheCapsuleWouldHangBelowItAndIsNotDrawn() {
        var p = OverlayPlacement(cursorRect: CGRect(x: 400, y: 204, width: 1, height: 16), fieldRect: view, cursorRectQuality: .exact)
        p.presentation = .capsule
        XCTAssertEqual(GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil).cause, .capsuleOutsideWindow)
    }

    func testWithNoWindowFrameNoCapsuleIsDrawn() {
        var p = capsule(caretX: 790, field: view)
        XCTAssertEqual(GhostOverlay.keepCapsuleInWindow(&p, text: " x", font: font, window: nil, pid: nil).cause, .capsuleNoWindow)
    }
}
