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

/// The capsule's display: the caret-line rule keeps it on the caret's display, above the caret's
/// line where below would hang off the bottom (AppKit coordinates).
@MainActor
final class GhostCapsuleScreenTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 2560, height: 1415)
    private let window = CGRect(x: 600, y: 0, width: 600, height: 400)
    private let font = NSFont.systemFont(ofSize: 13)

    private func placement(caretY: CGFloat) -> OverlayPlacement {
        var p = OverlayPlacement(cursorRect: CGRect(x: 900, y: caretY, width: 1, height: 18),
                                 fieldRect: CGRect(x: 710, y: caretY - 3, width: 320, height: 24), cursorRectQuality: .exact)
        p.presentation = .capsule
        return p
    }

    func testACapsuleWithRoomBelowTheCaretGoesBelow() {
        var p = placement(caretY: 120)
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil, displays: [screen])
        XCTAssertNil(kept.cause)
        XCTAssertEqual(kept.side, .below)
    }

    func testNearTheDisplaysBottomItGoesAbove() {
        // AppKit coordinates: a caret 10 pt above the bottom edge leaves no room below.
        var p = placement(caretY: 10)
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil, displays: [screen])
        XCTAssertNil(kept.cause)
        XCTAssertEqual(kept.side, .above)
    }

    func testACaretOnNoDisplayIsRefused() {
        var p = placement(caretY: 3000)
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: CGRect(x: 600, y: 2900, width: 600, height: 400),
                                                    pid: nil, displays: [screen])
        XCTAssertEqual(kept.cause, .capsuleNoRoom)
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
    private let display = CGRect(x: 0, y: 0, width: 2560, height: 1415)

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
        XCTAssertNil(GhostOverlay.keepCapsuleInWindow(&p, text: " in section two", font: font, window: window, pid: nil, displays: [display]).cause)
        let frame = drawn(" in section two", p)
        XCTAssertTrue(window.contains(frame), "KeyType's own layout, with the offsets set, lies in the window: \(frame)")
        XCTAssertEqual(frame.maxX, window.maxX, accuracy: 0.001)
    }

    /// Where KeyType draws the capsule for `text` with the offsets `keepCapsuleInWindow` set.
    private func drawn(_ text: String, _ p: OverlayPlacement) -> CGRect {
        let layout = GhostTextOverlayWindow.layout(for: text, font: font, placement: p)
        return layout.frame.offsetBy(dx: CGFloat(p.horizontalOffset), dy: -CGFloat(p.verticalOffset(Double(layout.lineHeight))))
    }

    /// V1a check 4's fix: a candidate wider than the window is bounded to it, not refused.
    func testACapsuleWiderThanTheWindowIsBoundedInsideIt() {
        let narrow = CGRect(x: 100, y: 200, width: 120, height: 500)
        var p = capsule(caretX: 180, field: narrow)
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " in section two of the draft", font: font, window: narrow, pid: nil)
        XCTAssertNil(kept.cause)
    }

    /// V1a check 4's fix: on the last visible line the capsule goes above the caret's line.
    func testOnTheWindowsLastLineTheCapsuleGoesAboveTheCaretsLine() {
        let caret = CGRect(x: 400, y: 204, width: 1, height: 16)
        var p = OverlayPlacement(cursorRect: caret, fieldRect: view, cursorRectQuality: .exact)
        p.presentation = .capsule
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil)
        XCTAssertNil(kept.cause)
        let frame = drawn(" later", p)
        XCTAssertTrue(window.contains(frame), "\(frame)")
        XCTAssertGreaterThanOrEqual(frame.minY, caret.maxY, "AppKit: above the caret's line, clear of it: \(frame)")
    }

    /// The oversized candidate's capsule shows a shortened text that fits the window; Tab still
    /// takes the whole text (the offer keeps it; only what is drawn is shortened).
    func testTheBoundedCapsuleShowsAShortenedTextInsideTheWindow() {
        let narrow = CGRect(x: 100, y: 200, width: 120, height: 500)
        var p = capsule(caretX: 180, field: narrow)
        let text = " in section two of the draft"
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: text, font: font, window: narrow, pid: nil, displays: [display])
        XCTAssertNil(kept.cause)
        XCTAssertTrue(kept.text.hasSuffix("…"), kept.text)
        XCTAssertTrue(text.hasPrefix(String(kept.text.dropLast())), "the head of the text: \(kept.text)")
        XCTAssertTrue(narrow.contains(drawn(kept.text, p)), "\(drawn(kept.text, p))")
    }

    /// The visible text area comes first: mid-document the capsule stays inside it, under the caret's
    /// line, even where the window has room above the text view (its toolbar).
    func testTheCapsuleStaysInTheVisibleTextArea() {
        let visible = CGRect(x: 100, y: 200, width: 700, height: 440)
        var p = capsule(caretX: 400, field: view)
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil, viewport: visible, displays: [display])
        XCTAssertNil(kept.cause)
        XCTAssertTrue(visible.contains(drawn(" later", p)))
        XCTAssertEqual(kept.side, .below)
    }

    /// A one-line viewport (a single-line field) has no room on either side; the window does.
    func testAOneLineViewportFallsBackToTheWindow() {
        let field = CGRect(x: 300, y: 497, width: 300, height: 22)
        var p = OverlayPlacement(cursorRect: CGRect(x: 400, y: 500, width: 1, height: 16), fieldRect: field, cursorRectQuality: .exact)
        p.presentation = .capsule
        let kept = GhostOverlay.keepCapsuleInWindow(&p, text: " later", font: font, window: window, pid: nil, viewport: field, displays: [display])
        XCTAssertNil(kept.cause)
        XCTAssertFalse(field.contains(drawn(" later", p)))
        XCTAssertTrue(window.contains(drawn(" later", p)))
    }

    func testWithNoWindowFrameNoCapsuleIsDrawn() {
        var p = capsule(caretX: 790, field: view)
        XCTAssertEqual(GhostOverlay.keepCapsuleInWindow(&p, text: " x", font: font, window: nil, pid: nil).cause, .capsuleNoWindow)
    }
}
