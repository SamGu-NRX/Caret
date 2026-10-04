import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// What Caret knows as VoiceOver and Full Keyboard Access reach it: every control a person needs is
/// a button with a name, and pressing it through accessibility does what a click does. The window is
/// ordered in far off every display, never key and never shown, since SwiftUI builds no accessibility
/// tree for a view that is in no window on screen (U1). Tab order between the buttons needs a key
/// window, which needs Caret frontmost; that walk runs on screen or in the VM, not here.
@MainActor
final class KnowsAccessibilityTests: XCTestCase {
    private func tree(_ view: some View) -> (NSWindow, [any NSAccessibilityProtocol]) {
        let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: MemoryView.size.width, height: MemoryView.size.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        var found: [any NSAccessibilityProtocol] = []
        func walk(_ element: any NSAccessibilityProtocol, depth: Int) {
            guard depth < 40 else { return }
            found.append(element)
            for child in (element.accessibilityChildren() ?? []).compactMap({ $0 as? any NSAccessibilityProtocol }) { walk(child, depth: depth + 1) }
        }
        if let content = window.contentView { walk(content, depth: 0) }
        return (window, found)
    }

    private func button(_ elements: [any NSAccessibilityProtocol], _ label: String) -> (any NSAccessibilityProtocol)? {
        elements.first { $0.accessibilityRole() == .button && ($0.accessibilityLabel() ?? "") == label }
    }

    func testEveryControlOfTheM1StatesIsANamedButtonThatPresses() throws {
        var sent: [MemoryAction] = []
        let view = MemoryView(state: Gallery.memoryState(entries: Gallery.noticedEntries()), files: Gallery.memoryFileOpen(conflict: true),
                              tab: .memory, character: .pebble, animated: false, now: Gallery.memoryNow, editorApp: "TextEdit") { sent.append($0) }
            .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
            .environment(\.locale, Locale(identifier: "en_US"))
        let (window, elements) = tree(view)
        defer { window.orderOut(nil); window.close() }
        let buttons = elements.filter { $0.accessibilityRole() == .button }
        try XCTSkipIf(buttons.isEmpty, "SwiftUI built no accessibility tree for a window off every display on this Mac")

        let expected: [(String, MemoryAction)] = [
            ("Reload", .reloadFile),
            ("Keep my text", .keepMyText),
            ("Open in TextEdit", .openInEditor),
            ("Edit People", .openFile("people")),
            ("Show People in Finder", .showInFinder("people")),
            ("Keep: Sam in Messages Fixture means Sam Okafor", .control("people-2", .keep, typed: false)),
            ("Not right: Sam in Messages Fixture means Sam Okafor", .control("people-2", .notRight, typed: false)),
            ("Memory", .tab(.memory)),
            ("Permissions", .tab(.permissions)),
        ]
        var missing: [String] = []
        for (label, action) in expected {
            guard let b = button(elements, label) else {
                missing.append(label)
                continue
            }
            sent.removeAll()
            XCTAssertTrue(b.accessibilityPerformPress(), label)
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            XCTAssertEqual(sent, [action], label)
        }
        XCTAssertEqual(missing, [], "buttons found: \(buttons.compactMap { $0.accessibilityLabel() })")
    }

    /// The open "Not right": its field has a name, and Forget, Save and Cancel are buttons.
    func testNotRightOnARowIsReachable() throws {
        var sent: [MemoryAction] = []
        let state = Gallery.memoryState({ $0.beginNotRight("people-2") }, entries: Gallery.noticedEntries())
        let view = MemoryView(state: state, files: Gallery.memoryFiles(), tab: .memory, character: .pebble, animated: false, now: Gallery.memoryNow) { sent.append($0) }
        let (window, elements) = tree(view)
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(elements.filter { $0.accessibilityRole() == .button }.isEmpty, "no accessibility tree off screen")
        XCTAssertNotNil(elements.first { $0.accessibilityRole() == .textField && $0.accessibilityLabel() == "What's right instead" }, "the correction field has a name")
        for (label, action) in [("Forget", MemoryAction.sendCorrection(forget: true)), ("Save", .sendCorrection(forget: false)), ("Cancel", .cancelCorrection)] {
            let b = try XCTUnwrap(button(elements, label), label)
            sent.removeAll()
            XCTAssertTrue(b.accessibilityPerformPress(), label)
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            XCTAssertEqual(sent, [action], label)
        }
    }

    /// The permissions' pop-up buttons say their rule as their value, so VoiceOver reads "Write
    /// where you are, Ask first, button".
    func testEachRuleIsAPopUpButtonNamedForItsAction() throws {
        let view = MemoryView(state: Gallery.memoryState(), tab: .permissions, character: .pebble, animated: false, now: Gallery.memoryNow)
        let (window, elements) = tree(view)
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(elements.filter { $0.accessibilityRole() == .button }.isEmpty, "no accessibility tree off screen")
        let rule = try XCTUnwrap(button(elements, "Write where you are"))
        XCTAssertEqual(rule.accessibilityValue() as? String, "Ask first")
    }
}
