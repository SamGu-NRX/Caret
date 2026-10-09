import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Onboarding's keyboard operability (O14): every pane exposes its controls to VoiceOver and Full Keyboard Access as
/// named buttons and fields (no anonymous clickable rows), the bar keeps both choices on every multi-step pane, the
/// drag row and the drag panel's close are operable without a pointer, and the window's key tap leaves the keys a
/// focused control needs: Return presses the button Full Keyboard Access focused instead of turning into Continue.
///
/// Like OnboardingPromiseAccessibilityTests, the window sits far off every display by default, where SwiftUI builds no
/// accessibility tree on this Mac, so the tests skip; `CARET_AX_ONSCREEN=1` puts it on the main display, for a run
/// under the gui lease while the Mac is idle.
@MainActor
final class OnboardingKeyboardTests: XCTestCase {
    // MARK: - Walking a pane

    private func tree(_ view: some View) -> (NSWindow, [any NSAccessibilityProtocol]) {
        let onScreen = ProcessInfo.processInfo.environment["CARET_AX_ONSCREEN"] == "1"
        let origin = onScreen ? NSPoint(x: 80, y: 80) : NSPoint(x: -30000, y: -30000)
        let window = NSWindow(contentRect: NSRect(origin: origin, size: OnboardingView.size(for: .main)), styleMask: [.borderless], backing: .buffered, defer: false)
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

    private func field(_ elements: [any NSAccessibilityProtocol], _ label: String) -> (any NSAccessibilityProtocol)? {
        elements.first { $0.accessibilityRole() == .textField && ($0.accessibilityLabel() ?? "") == label }
    }

    private func keyEvent(_ keyCode: UInt16, _ characters: String) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                                       characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
    }

    // MARK: - A state per step

    private func helloFlow() -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .hello))
        flow.start()
        flow.send(.model(.ready))
        flow.send(.typed("Dear Dana,"))
        return flow
    }

    private func accessFlow(stale: Bool) -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: false, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .access))
        flow.start()
        flow.send(.staleGrant(stale))
        return flow
    }

    private func browserFlow() -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .browser))
        flow.start()
        flow.send(.browsers(trusted: ["Google Chrome"], untrusted: []))
        return flow
    }

    private func onFlow() -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .on), jevKeyAvailable: false)
        flow.start()
        flow.send(.previewReady(requestId: "preview-1-1", OnboardingPreview(previewId: "pv", windows: [
            .init(bundleId: "com.apple.mail", appName: "Mail", title: "Thursday?", lines: [.init(text: "Thursday at 3"), .init(text: nil)], chars: 13),
        ], chars: 13)))
        flow.send(.setJevKey("key-4211"))
        return flow
    }

    /// The first pane, by way of the look the host asks and the helper answers (`firstLookReply`), since a found offer
    /// cannot be injected into the state directly.
    private func firstFlow(found: Bool) throws -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .on))
        flow.start()
        flow.send(.previewReady(requestId: "preview-1-1", OnboardingPreview(previewId: "pv", windows: [
            .init(bundleId: "com.apple.mail", appName: "Mail", title: "Thursday?", lines: [.init(text: "Thursday at 3"), .init(text: nil)], chars: 13),
        ], chars: 13)))
        var request: FirstLookRequest?
        flow.output = {
            if case .askFirstLook(let asked, _) = $0 { request = asked }
        }
        flow.send(.next)
        let asked = try XCTUnwrap(request, "the first look was asked")
        let synthetic = #"{"kind":"fill","family":"fill","offerKey":"\#(FirstLookReply.offerKey(requestId: asked.requestId))","window":{"pid":5151,"windowId":"5151-2","appName":"Safari","title":"Payment"},"spec":{"v":1,"id":"\#(FirstLookReply.offerKey(requestId: asked.requestId))","figure":"offering","blocks":[{"type":"header","title":{"text":"Fill 4 fields","ref":{"rule":"count","derived":[{"node":"5151-2/form"}]}}},{"type":"fields","rows":[{"destination":{"text":"Name","ref":{"node":"n"}},"value":{"text":"Dana Reyes","ref":{"node":"m","quote":"Dana Reyes"}},"state":"ready"}],"more":3},{"type":"actions","items":[{"id":"fillAll","label":"Fill all","key":"tab"}]}]}"#
        let reply = FirstLookReply(requestId: asked.requestId, at: 1, outcome: found ? .found : .nothing,
                                   found: found ? try JSONDecoder().decode(FirstLookReply.Found.self, from: Data(synthetic.utf8)) : nil)
        flow.send(.firstLookReply(reply))
        XCTAssertEqual(flow.state.step, .first)
        return flow
    }

    private struct Pane {
        var name: String
        var flow: OnboardingFlow
        /// The buttons the pane must name; each is pressed through accessibility as a click would.
        var pressable: [String]
        /// Buttons present and named, not pressed (a press would leave this test's process: Finder).
        var named: [String] = []
        var fields: [String] = []
        var dots: String
    }

    private func panes() throws -> [Pane] {
        [
            Pane(name: "hello", flow: helloFlow(), pressable: [OnboardingCopy.Hello.primary, OnboardingCopy.Hello.later],
                 fields: [OnboardingCopy.Hello.fieldLabel], dots: "Step 1 of 5"),
            Pane(name: "access", flow: accessFlow(stale: false), pressable: [OnboardingCopy.Access.help, OnboardingCopy.Hello.later],
                 named: [OnboardingCopy.Drag.voiceOver], dots: "Step 2 of 5"),
            Pane(name: "access, older copy", flow: accessFlow(stale: true),
                 pressable: [OnboardingCopy.Access.reset, OnboardingCopy.Access.help, OnboardingCopy.Hello.later], dots: "Step 2 of 5"),
            Pane(name: "browser", flow: browserFlow(), pressable: [OnboardingCopy.Browser.add("Google Chrome"), OnboardingCopy.Browser.skip],
                 dots: "Step 3 of 5"),
            Pane(name: "on", flow: onFlow(), pressable: [OnboardingCopy.On.send, OnboardingCopy.On.keep], fields: ["Jev key"], dots: "Step 4 of 5"),
            Pane(name: "first, found", flow: try firstFlow(found: true), pressable: ["Fill all", OnboardingCopy.First.notNow], dots: "Step 5 of 5"),
            Pane(name: "first, nothing", flow: try firstFlow(found: false), pressable: [OnboardingCopy.First.done], dots: "Step 5 of 5"),
        ]
    }

    // MARK: - The tree

    /// Every pane's controls are named buttons and fields, with both bar choices wherever the flow offers them and the
    /// dots reading the place: nothing clickable without a name, on any step.
    func testEveryPaneExposesNamedControlsAndBothBarChoices() throws {
        for pane in try panes() {
            let (window, elements) = tree(OnboardingView(state: pane.flow.state, character: .pebble, animated: false))
            defer { window.orderOut(nil); window.close() }
            try XCTSkipIf(elements.filter { $0.accessibilityRole() == .button }.isEmpty,
                          "SwiftUI built no accessibility tree for a window off every display on this Mac")
            let unnamed = elements.filter { $0.accessibilityRole() == .button && ($0.accessibilityLabel() ?? "").isEmpty }
                + elements.filter { $0.accessibilityRole() == .textField && ($0.accessibilityLabel() ?? "").isEmpty }
            XCTAssertTrue(unnamed.isEmpty, "\(pane.name): every button and field has a name (found \(unnamed.count) unnamed)")
            for label in pane.pressable {
                let b = try XCTUnwrap(button(elements, label), "\(pane.name): \(label) is a named button")
                XCTAssertTrue(b.accessibilityPerformPress(), "\(pane.name): \(label) presses")
            }
            for label in pane.named { XCTAssertNotNil(button(elements, label), "\(pane.name): \(label) is a named button") }
            for label in pane.fields { XCTAssertNotNil(field(elements, label), "\(pane.name): \(label) is a named field") }
            XCTAssertTrue(elements.contains { ($0.accessibilityLabel() ?? "") == pane.dots }, "\(pane.name): the dots read \(pane.dots)")
        }
    }

    // MARK: - The drag panel

    /// The panel's close: on hover for the mouse, and always in the tree for VoiceOver and Switch Control, who cannot
    /// hover; pressing it through accessibility closes the panel.
    func testTheDragPanelCloseIsThereWithoutHover() throws {
        var closed = 0
        let (window, elements) = tree(SettingsDragPanelView(model: SettingsDragPanelModel(), close: { closed += 1 })
            .environment(\.accessibilityVoiceOverEnabled, true))
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(elements.filter { $0.accessibilityRole() == .button }.isEmpty,
                      "SwiftUI built no accessibility tree for a window off every display on this Mac")
        let close = try XCTUnwrap(button(elements, OnboardingCopy.Drag.close), "Close is a named button without a hover")
        XCTAssertTrue(close.accessibilityPerformPress(), "Close presses")
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(closed, 1)
    }

    /// The sighted design is unchanged: no hover, no close in the tree; the drag row is still the row's named button.
    func testTheDragPanelCloseStaysHoverOnlyForTheMouse() throws {
        let (window, elements) = tree(SettingsDragPanelView(model: SettingsDragPanelModel(), close: {}))
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(elements.filter { $0.accessibilityRole() == .button }.isEmpty,
                      "SwiftUI built no accessibility tree for a window off every display on this Mac")
        XCTAssertNil(button(elements, OnboardingCopy.Drag.close), "the close stays hover-revealed for the mouse")
        XCTAssertNotNil(button(elements, OnboardingCopy.Drag.voiceOver), "the drag row is a named button")
    }

    /// The drag row takes the keyboard like its VoiceOver action: focusable (with the system's ring), Space and Return
    /// press it, Esc does not.
    func testTheDragRowTakesTheKeyboard() throws {
        let row = DragRowView(frame: NSRect(x: 0, y: 0, width: 220, height: 52))
        var pressed = 0
        row.onPress = { pressed += 1 }
        XCTAssertEqual(row.accessibilityRole(), .button)
        XCTAssertEqual(row.accessibilityLabel(), OnboardingCopy.Drag.voiceOver)
        XCTAssertTrue(row.acceptsFirstResponder, "Full Keyboard Access can focus the row")
        for (key, code, characters) in [("space", UInt16(49), " "), ("return", UInt16(36), "\r"), ("keypad return", UInt16(76), "\r")] {
            row.keyDown(with: try keyEvent(code, characters))
            XCTAssertEqual(pressed, 1, "\(key) presses the row")
            pressed = 0
        }
        row.keyDown(with: try keyEvent(53, "\u{1b}"))
        XCTAssertEqual(pressed, 0, "Esc does not press the row")
    }

    // MARK: - The key tap

    /// The window's key tap (OnboardingController owns it): Return belongs to the button Full Keyboard Access focused
    /// and stays the primary everywhere else; Space is never mapped; Tab moves focus when the step has no ghost to take.
    func testReturnBelongsToTheFocusedButtonBeforeThePrimary() throws {
        let state = helloFlow().state
        XCTAssertNil(OnboardingController.event(for: try keyEvent(36, "\r"), state: state, focusedButton: true),
                     "a focused button keeps Return: the tap passes it through")
        XCTAssertEqual(OnboardingController.event(for: try keyEvent(36, "\r"), state: state, focusedButton: false), .next)
        XCTAssertNil(OnboardingController.event(for: try keyEvent(76, "\r"), state: state, focusedButton: true), "keypad return too")
        XCTAssertEqual(OnboardingController.event(for: try keyEvent(76, "\r"), state: state), .next)
        XCTAssertNil(OnboardingController.event(for: try keyEvent(49, " "), state: state), "space is a button's own press, never mapped")
        XCTAssertNil(OnboardingController.event(for: try keyEvent(48, "\t"), state: state), "Tab without a ghost moves focus")
        XCTAssertEqual(OnboardingController.event(for: try keyEvent(53, "\u{1b}"), state: try firstFlow(found: true).state), .key(.escape),
                       "Esc is the offer's leave on the first step")
    }
}
