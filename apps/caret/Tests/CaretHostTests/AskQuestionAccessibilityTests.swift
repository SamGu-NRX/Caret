import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// A fields question as VoiceOver reads it: every row offers Select or Clear for its own option, and a row reads as
/// selected by its box, not by the highlight. A question with one answer offers neither. A value question's rows each
/// offer Choose, read the value then where it came from, and come after the question and the "Caret will fill" line.
///
/// As in OnboardingPromiseAccessibilityTests, the window sits far off every display by default, where SwiftUI builds no
/// accessibility tree on this Mac, so the test skips; `CARET_AX_ONSCREEN=1` puts it on the main display, for a run
/// under the gui lease while the Mac is idle.
@MainActor
final class AskQuestionAccessibilityTests: XCTestCase {
    /// On screen, a missing row fails the test instead of skipping it.
    static let onScreen = ProcessInfo.processInfo.environment["CARET_AX_ONSCREEN"] == "1"

    private func rows(_ view: some View) -> (NSWindow, [String: any NSAccessibilityProtocol]) {
        let (window, ordered) = elements(view) { $0.contains("Current residence") || $0.contains("TextEdit") }
        return (window, Dictionary(ordered, uniquingKeysWith: { first, _ in first }))
    }

    /// The labelled elements `matches` picks, in VoiceOver's reading order (a depth-first walk of the tree).
    private func elements(_ view: some View, matching matches: (String) -> Bool) -> (NSWindow, [(String, any NSAccessibilityProtocol)]) {
        let origin = Self.onScreen ? NSPoint(x: 80, y: 80) : NSPoint(x: -30000, y: -30000)
        let window = NSWindow(contentRect: NSRect(origin: origin, size: NSSize(width: 360, height: 240)), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        var found: [(String, any NSAccessibilityProtocol)] = []
        func walk(_ element: any NSAccessibilityProtocol, depth: Int) {
            guard depth < 40 else { return }
            // A row carries its words as a label; a plain Text, such as the question, as its value.
            let words = element.accessibilityLabel().flatMap { $0.isEmpty ? nil : $0 } ?? (element.accessibilityValue() as? String)
            if let words, matches(words) { found.append((words, element)) }
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

    func testEachValueRowReadsItsValueAndSourceAndChoosesItsOwnOption() throws {
        var chosen: [String] = []
        let question = AskCaret.Question(ask: Gallery.askValueQuestion())
        let words = [
            question.ask.text, "Caret will fill First name: Grace, Last name: Oduya",
            "grace.oduya@example.com, from Your saved Email",
            "g.oduya@lumen.example, from Venue deposit and Thursday review: Grace's other address: g.oduya@lumen.example",
            "Leave blank",
        ]
        let (window, found) = elements(AskQuestionCard(question: question, onChoose: { chosen.append($0) })) { words.contains($0) }
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(found.isEmpty && !Self.onScreen, "SwiftUI built no accessibility tree for a window off every display on this Mac")

        XCTAssertEqual(found.map(\.0), words, "the question, the Caret will fill line, then the rows")
        for (_, row) in found.suffix(3) {
            XCTAssertEqual(actions(row), ["Choose"])
            XCTAssertFalse(row.isAccessibilitySelected(), "nothing is highlighted as a value question opens")
        }
        let other = try XCTUnwrap(found.first { $0.0 == words[3] }?.1, "the second value's row")
        _ = (other.accessibilityCustomActions() ?? []).first?.handler?()
        XCTAssertEqual(chosen, ["o2"])
    }
}
