import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// The `on` pane as VoiceOver reads it: the promise it shows is exactly the text it was given, block by block and in
/// order, and nothing else on the pane reads like a promise except the consent lines `OnboardingCopy.On` holds, which
/// say what this one look may send. This backs scripts/check_onboarding_privacy.py,
/// which checks the source, with what the built view exposes.
///
/// Like KnowsAccessibilityTests, the window sits far off every display by default, where SwiftUI builds no
/// accessibility tree on this Mac, so the test skips; `CARET_AX_ONSCREEN=1` puts it on the main display, for a run
/// under the gui lease while the Mac is idle.
@MainActor
final class OnboardingPromiseAccessibilityTests: XCTestCase {
    /// Sentinel blocks with tokens that appear nowhere else in Caret.
    static let blocks = [
        "Zebra heading qv7",
        "Zebra paragraph one qv7 carries a token found nowhere else, long enough to wrap in the step.",
        "Yak heading qv7",
        "Yak paragraph two qv7 is short.",
        "Yak paragraph three qv7 closes the sentinel.",
    ]
    /// Words that only a privacy promise would use. Outside the sentinel blocks, no text on the step may hold one.
    static let promiseWords = ["send", "cloud", "model", "receive", "privacy", "promise", "request", "train", "keep", "Jev", "Groq", "TypeSafe", "leave"]

    private func texts(_ view: some View) -> (NSWindow, [String]) {
        let onScreen = ProcessInfo.processInfo.environment["CARET_AX_ONSCREEN"] == "1"
        let origin = onScreen ? NSPoint(x: 80, y: 80) : NSPoint(x: -30000, y: -30000)
        let window = NSWindow(contentRect: NSRect(origin: origin, size: OnboardingView.size(for: .main)), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        var found: [String] = []
        func walk(_ element: any NSAccessibilityProtocol, depth: Int) {
            guard depth < 40 else { return }
            if element.accessibilityRole() == .staticText || element.accessibilityRole()?.rawValue == "AXHeading" {
                let text = (element.accessibilityValue() as? String).flatMap { $0.isEmpty ? nil : $0 } ?? element.accessibilityLabel() ?? ""
                if !text.isEmpty { found.append(text) }
            }
            for child in (element.accessibilityChildren() ?? []).compactMap({ $0 as? any NSAccessibilityProtocol }) { walk(child, depth: depth + 1) }
        }
        if let content = window.contentView { walk(content, depth: 0) }
        return (window, found)
    }

    func testThePromiseReadsAsExactlyTheInjectedBlocksInOrder() throws {
        let promise = try XCTUnwrap(PrivacyPromise(Self.blocks.joined(separator: PrivacyPromise.separator)))
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: .on))
        flow.start()
        flow.send(.previewReady(requestId: "preview-1-1", OnboardingPreview(previewId: "pv", windows: [.init(bundleId: "com.apple.mail", appName: "Mail",
            title: "Thursday?", lines: [.init(text: "Thursday at 3"), .init(text: nil)], chars: 13)], chars: 13)))
        XCTAssertEqual(flow.state.step, .on)
        let (window, found) = texts(OnboardingView(state: flow.state, character: .pebble, animated: false, promise: promise))
        defer { window.orderOut(nil); window.close() }
        try XCTSkipIf(found.isEmpty, "SwiftUI built no accessibility tree for a window off every display on this Mac")

        XCTAssertEqual(found.filter { $0.contains("qv7") }, Self.blocks, "every text on the step: \(found)")
        // The consent block says what this look may send, on purpose; it is the only other text with these words.
        let consent: Set<String> = [OnboardingCopy.On.consentHead, OnboardingCopy.On.consentLine(chars: 13, windows: 1), OnboardingCopy.On.stepDetail,
                                    "Needs the cloud model", OnboardingCopy.On.promiseLabel]
        let rest = found.filter { !$0.contains("qv7") && !consent.contains($0) }
        for text in rest {
            let words = Self.promiseWords.filter { text.range(of: $0, options: .caseInsensitive) != nil }
            XCTAssertEqual(words, [], "text outside the injected promise reads like one: \(text)")
        }
        // The pane's own words come first, then the promise: it sits under the consent block.
        let firstBlock = try XCTUnwrap(found.firstIndex(of: Self.blocks[0]))
        XCTAssertTrue(found[..<firstBlock].contains(OnboardingCopy.On.title), "\(found)")
        let lastBlock = try XCTUnwrap(found.lastIndex(of: Self.blocks[Self.blocks.count - 1]))
        XCTAssertFalse(found[firstBlock...lastBlock].contains { !$0.contains("qv7") }, "nothing reads between the promise's blocks: \(found)")
    }
}
