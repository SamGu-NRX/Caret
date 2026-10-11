import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H11's states against their references, light and dark: the page task panel from preview to its end, the
/// desk's line when the preview is at the form, the quiet offer to keep an answer, and a saved answer shown
/// whole in the fill preview. Contrast of every token the panel draws is measured from rendered pixels, over a
/// white page and a dark editor, as `ContrastRenderTests` measures the other surfaces.
@MainActor
final class H11RenderTests: XCTestCase {
    func testH11StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h11())
    }

    func testThePanelsTextAndMarksMeetTheirContrastInBothThemes() throws {
        let text = 4.5, mark = 3.0
        let views = Dictionary(uniqueKeysWithValues: Gallery.h11().map { ($0.name, $0.view) })
        let surfaces: [(String, AnyView, [ContrastRenderTests.Probe])] = [
            ("Preview", views["page-task-preview"]!, [
                .init(name: "Ink, title and values", token: Tokens.ink, minimum: text),
                .init(name: "Ink 2, labels, source, picked, withheld, keys", token: Tokens.ink2, minimum: text),
                .init(name: "Carrot text, attach yourself", token: Tokens.carrotText, minimum: text),
            ]),
            ("Progress", views["page-task-progress"]!, [
                .init(name: "Ink 2, checks and already so", token: Tokens.ink2, minimum: text),
                .init(name: "Ink 3, rings to do", token: Tokens.ink3, minimum: mark),
                .init(name: "Carrot, the line under the row being written", token: Tokens.carrot, minimum: mark),
            ]),
            ("Reveal", views["page-task-reveal"]!, [.init(name: "Ink, the caption over what appeared", token: Tokens.ink, minimum: text)]),
            ("Hand-off", views["page-task-handoff"]!, [.init(name: "Carrot text, You press 'Next'", token: Tokens.carrotText, minimum: text)]),
            ("Partly done", views["page-task-partial"]!, [.init(name: "Carrot text, Partly done", token: Tokens.carrotText, minimum: text)]),
            ("Desk at the form", views["desk-preview-at-form"]!, [.init(name: "Ink 2, Preview at the form", token: Tokens.ink2, minimum: text)]),
            ("Save offer", views["answer-save-offer"]!, [.init(name: "Ink, the question", token: Tokens.ink, minimum: text),
                                                         .init(name: "Ink 2, ⌘1 Save and Esc", token: Tokens.ink2, minimum: text)]),
            ("Saved answer whole", views["fill-preview-saved-answer"]!, [.init(name: "Ink, the answer", token: Tokens.ink, minimum: text)]),
        ]
        var table = ["| Surface | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, view, probes) in surfaces {
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
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | \(probe.minimum == 4.5 ? "4.5 text" : "3 mark") |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-h11.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    /// The panel's words, as the gallery's states say them.
    func testThePanelsWords() throws {
        let panels = Dictionary(uniqueKeysWithValues: Gallery.h11Panels())
        XCTAssertEqual(panels["page-task-preview"]?.title, "Fill 9 fields on this page")
        XCTAssertEqual(panels["page-task-preview"]?.hints, [Hint(key: "Tab", label: "Fill 9"), Hint(key: "Esc")])
        XCTAssertEqual(panels["page-task-reveal"]?.sections.last?.caption, "2 more fields appeared")
        XCTAssertEqual(panels["page-task-handoff"]?.yours.map(\.text), ["Attach 'Resume/CV' yourself", "You press 'Next'."])
        XCTAssertEqual(panels["page-task-next-page"]?.title, "Next page: fill 5 fields")
        XCTAssertEqual(panels["page-task-done"]?.lead, "Done:")
        XCTAssertEqual(panels["page-task-handoff"]?.lead, "Ready:")
        XCTAssertEqual(panels["page-task-handoff"]?.title, "4 done.")
        XCTAssertEqual(panels["page-task-done"]?.hints, [Hint(key: "⌘Z", label: "Undo")])
    }
}
