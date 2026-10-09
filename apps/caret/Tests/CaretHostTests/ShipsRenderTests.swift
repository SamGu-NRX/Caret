import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H12's onboarding screens against their references, light and dark, their contrast measured from rendered pixels
/// the way U1 and U2 measured theirs (`ContrastRenderTests.measure`), and their copy against the rules.
@MainActor
final class ShipsRenderTests: XCTestCase {
    func testTheKeyStepMatchesItsReferences() throws {
        try SnapshotTests.check(Gallery.onboardingJevKey())
    }

    func testTheKeyStepsTextAndMarksMeetTheirContrastInBothThemes() throws {
        typealias P = ContrastRenderTests.Probe
        let text = 4.5, mark = 3.0
        let shots = Dictionary(uniqueKeysWithValues: Gallery.onboardingJevKey().map { ($0.name, $0.view) })
        let surfaces: [(String, String, [P])] = [
            ("Key, as it opens", "onboarding-key", [P(name: "Ink, title", token: Tokens.ink, minimum: text),
                                                    P(name: "Ink 2, detail, label, placeholder, footnote, Back, Skip", token: Tokens.ink2, minimum: text),
                                                    P(name: "Carrot, the field's focus ring and the current dot", token: Tokens.carrot, minimum: mark),
                                                    P(name: "Ink 3, the other dots and the hatched lines", token: Tokens.ink3, minimum: mark)]),
            // No On ink probe as it opens: with no key yet, Send these and look is disabled, and WCAG 1.4.3 exempts
            // inactive components (it measured 1.49:1 drawn disabled, CI run 37906771739).
            ("Key, pasted", "onboarding-key-typed", [P(name: "Ink, the key's dots", token: Tokens.ink, minimum: text)]),
            // No probe on the checking screen: Back, Skip and Continue are disabled there, and WCAG 1.4.3 exempts inactive
            // controls; the checking line is Ink 2 on the same window, measured on the screen as it opens.
            ("Key, no credits", "onboarding-key-no-credits", [P(name: "Ink, what to do", token: Tokens.ink, minimum: text)]),
            ("Key, rejected", "onboarding-key-rejected", [P(name: "Ink, the problem", token: Tokens.ink, minimum: text)]),
            ("Key alone, a key saved", "onboarding-key-alone-stored", [P(name: "Ink 2, the saved line", token: Tokens.ink2, minimum: text),
                                                                      P(name: "On ink, Done", token: Tokens.onInk, minimum: text)]),
        ]
        var table = ["| Screen | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, name, probes) in surfaces {
            let view = try XCTUnwrap(shots[name], name)
            for probe in probes {
                var cells: [String] = []
                for dark in [false, true] {
                    for (ground, hex) in ContrastRenderTests.grounds {
                        let ratio = try ContrastRenderTests.measure(view, token: probe.token, dark: dark, canvas: hex)
                        cells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
                        if let ratio, ratio < probe.minimum {
                            failures.append("\(surface), \(probe.name), \(dark ? "dark" : "light") over \(ground): \(String(format: "%.2f", ratio))")
                        }
                        if ratio == nil { failures.append("\(surface), \(probe.name): nothing drawn in that token") }
                    }
                }
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | \(probe.minimum == text ? "4.5 text" : "3 mark") |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-h12.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    /// The key field's words: what happens to the key, and the coordinator's sentence for a key whose account has no
    /// credits.
    func testTheKeyFieldsWordingIsPinned() {
        XCTAssertEqual(OnboardingCopy.On.keyNote, "For now the cloud model needs a key. Caret keeps it in your login keychain and checks it with one small request.")
        var draft = OnboardingFlow.JevKeyDraft()
        draft.phase = .checked(.noCredits, saved: true)
        XCTAssertEqual(KeyBlock.line(draft)?.text, "This key works, but its account has no credits. Add credits at console.typesafe.ai.")
        draft.phase = .checked(.rejected, saved: false)
        XCTAssertEqual(KeyBlock.line(draft)?.problem, true)
        draft.phase = .checked(.unreachable, saved: false)
        XCTAssertTrue(KeyBlock.line(draft)?.text.contains("try again") ?? false)
        var lines = [OnboardingCopy.On.keyNote, OnboardingCopy.On.keyPlaceholder]
        for phase in [OnboardingFlow.JevKeyDraft.Phase.malformed, .checking, .checked(.works, saved: true), .checked(.works, saved: false),
                      .checked(.unclear(status: 500), saved: false)] {
            draft.phase = phase
            lines.append(KeyBlock.line(draft)?.text ?? "")
        }
        for line in lines {
            XCTAssertFalse(line.contains("\u{2014}") || line.contains("\u{2013}") || line.contains("!"), line)
            XCTAssertFalse(line.isEmpty)
        }
    }

    /// ⌘V reaches the key field although Caret has no Edit menu.
    func testTheEditKeysMapToTheEditMenusActions() throws {
        func key(_ c: String, _ flags: NSEvent.ModifierFlags) throws -> NSEvent {
            try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                                           characters: c, charactersIgnoringModifiers: c, isARepeat: false, keyCode: 9))
        }
        XCTAssertEqual(OnboardingController.editAction(for: try key("v", .command)), #selector(NSText.paste(_:)))
        XCTAssertEqual(OnboardingController.editAction(for: try key("a", .command)), #selector(NSText.selectAll(_:)))
        XCTAssertNil(OnboardingController.editAction(for: try key("v", [.command, .shift])))
        XCTAssertNil(OnboardingController.editAction(for: try key("v", [])))
    }
}
