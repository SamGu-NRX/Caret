import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// A fields question as VoiceOver reads it: every row offers Select or Clear for its own option, and a row reads as
/// selected by its box, not by the highlight. A question with one answer offers neither.
///
/// As in OnboardingPromiseAccessibilityTests, the window sits far off every display by default, where SwiftUI builds no
/// accessibility tree on this Mac, so the test skips; `CARET_AX_ONSCREEN=1` puts it on the main display, for a run
/// under the gui lease while the Mac is idle.
@MainActor
final class AskQuestionAccessibilityTests: XCTestCase {
    /// On screen, a missing row fails the test instead of skipping it.
    static let onScreen = ProcessInfo.processInfo.environment["CARET_AX_ONSCREEN"] == "1"

    private func rows(_ view: some View) -> (NSWindow, [String: any NSAccessibilityProtocol]) {
        let origin = Self.onScreen ? NSPoint(x: 80, y: 80) : NSPoint(x: -30000, y: -30000)
        let window = NSWindow(contentRect: NSRect(origin: origin, size: NSSize(width: 360, height: 240)), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        var found: [String: any NSAccessibilityProtocol] = [:]
        func walk(_ element: any NSAccessibilityProtocol, depth: Int) {
            guard depth < 40 else { return }
            if let label = element.accessibilityLabel(), label.contains("Current residence") || label.contains("TextEdit") { found[label] = element }
            for child in (element.accessibilityChildren() ?? []).compactMap({ $0 as? any NSAccessibilityProtocol }) { walk(child, depth: depth + 1) }
        }
        if let content = window.contentView { walk(content, depth: 0) }
        return (window, found)
    }

    private func actions(_ element: any NSAccessibilityProtocol) -> [String] {
        (element.accessibilityCustomActions() ?? []).map(\.name)
    }

    func testEachFieldsRowSelectsOrClearsItsOwnOption() throws {
        var picked: [String] = []
        let question = AskCaret.Question(ask: Gallery.askQuestion(part: .fields), highlight: 2, selected: ["o2"])
        let (window, found) = rows(AskQuestionCard(question: question, onSelect: { picked.append($0) }))
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(found.isEmpty && !Self.onScreen, "SwiftUI built no accessibility tree for a window off every display on this Mac")

        let name = try XCTUnwrap(found["Landlord name, Current residence"])
        let phone = try XCTUnwrap(found["Landlord phone, Current residence"])
        let rent = try XCTUnwrap(found["Monthly rent, Current residence"])
        XCTAssertEqual(actions(name), ["Select"])
        XCTAssertEqual(actions(phone), ["Clear"])
        XCTAssertFalse(rent.isAccessibilitySelected(), "the highlighted row is not selected until its box is")
        XCTAssertTrue(phone.isAccessibilitySelected())
        _ = (name.accessibilityCustomActions() ?? []).first?.handler?()
        XCTAssertEqual(picked, ["o1"])
    }

    func testARowOfAQuestionWithOneAnswerOffersNoSelect() throws {
        let question = AskCaret.Question(ask: Gallery.askQuestion(part: .source), highlight: 0)
        let (window, found) = rows(AskQuestionCard(question: question))
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(found.isEmpty && !Self.onScreen, "SwiftUI built no accessibility tree for a window off every display on this Mac")

        let notes = try XCTUnwrap(found["TextEdit, Rental notes.txt"])
        XCTAssertEqual(actions(notes), [])
        XCTAssertTrue(notes.isAccessibilitySelected(), "a one-answer row is selected by the highlight")
    }
}
