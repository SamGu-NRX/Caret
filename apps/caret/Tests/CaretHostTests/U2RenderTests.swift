import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// v3 part 2's surfaces against their references, light and dark: the slip and the pop-up with a
/// noticed fact's source and "Not right", the desk's card with it, and the menu bar glyph. The desk,
/// the rim, the knows window and onboarding are checked with their own tests.
@MainActor
final class U2RenderTests: XCTestCase {
    func testTheSlipWithItsSourceMatchesItsReferences() throws {
        try SnapshotTests.check(Gallery.provenance())
    }

    func testTheDeskCardWithItsSourceMatchesItsReferences() throws {
        try SnapshotTests.check(Gallery.deskProvenance())
    }

    func testTheMenuBarGlyphMatchesItsReference() throws {
        try SnapshotTests.check(Gallery.glyph())
    }

    /// The "Not right" row adds to the slip's height inside the same glass, so the placement that
    /// measures the slip measures the row too (it can cover nothing the slip would not).
    func testTheRowIsPartOfTheSlipItIsPlacedWith() throws {
        let plain = NSHostingView(rootView: LineView(content: Gallery.guestLine, character: .pebble, animated: false)).fittingSize
        let row = NSHostingView(rootView: LineView(content: Gallery.guestLine, character: .pebble, animated: false,
                                                   under: AnyView(NotRightRowView(row: Gallery.row(.shown), indent: LineView.textIndent(compact: false))))).fittingSize
        XCTAssertEqual(row.height, plain.height + 1 + NotRightRow.rowHeight, accuracy: 0.5)
        XCTAssertLessThanOrEqual(row.width, Tokens.Shape.slipMaxWidth)
    }

    /// The glyph is the body with the eyes cut out: a template image, opaque in the body and clear
    /// where each eye is.
    func testTheGlyphHasItsEyesCutOut() throws {
        let image = FigureGlyph.image(.pebble, working: false)
        XCTAssertTrue(image.isTemplate)
        // Drawn at 4x into a bitmap whose rows run top down, as the menu bar draws it.
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4,
                                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        rep.size = NSSize(width: 16, height: 16)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: 16, height: 16))
        NSGraphicsContext.restoreGraphicsState()
        func alpha(_ x: CGFloat, _ y: CGFloat) -> CGFloat {
            rep.colorAt(x: Int(x * 4), y: Int(y * 4))?.alphaComponent ?? 0
        }
        // The pebble in a 16 pt square, 13 wide: x from 1.5, y from about 2.04; eyes at viewBox (3.9, 5) and (8.1, 5).
        let k: CGFloat = 13 / 12
        let left = (1.5 + 3.9 * k, 2.04 + 5 * k), right = (1.5 + 8.1 * k, 2.04 + 5 * k), body = (8.0, 12.0)
        XCTAssertLessThan(alpha(left.0, left.1), 0.2, "left eye cut out")
        XCTAssertLessThan(alpha(right.0, right.1), 0.2, "right eye cut out")
        XCTAssertGreaterThan(alpha(body.0, body.1), 0.8, "the body is solid")
        XCTAssertFalse(FigureGlyph.image(.pebble, working: true).isTemplate, "lit, it is drawn in Carrot, not the bar's color")
    }

    // MARK: - Contrast, from rendered pixels

    /// Every new text and mark of part 2, measured the way U1 measured part 1 (`ContrastRenderTests`):
    /// each token hidden in turn, the changed pixels grouped into shapes, and the weakest shape's ratio
    /// against what is behind it. Windows are opaque, so their two backdrops read the same.
    static func surfaces() -> [(String, AnyView, [ContrastRenderTests.Probe])] {
        typealias P = ContrastRenderTests.Probe
        let text = 4.5, mark = 3.0
        func items(_ list: [Gallery.Item]) -> [String: AnyView] { Dictionary(uniqueKeysWithValues: list.map { ($0.name, $0.view) }) }
        let ask = items(Gallery.ask()), act = items(Gallery.activity()), knows = items(Gallery.knows()), memory = items(Gallery.memory())
        let slips = items(Gallery.provenance()), desk = items(Gallery.deskProvenance()), rim = items(Gallery.perch())
        return [
            ("Desk, empty", ask["ask-empty"]!, [P(name: "Ink 2, placeholder and empty line", token: Tokens.ink2, minimum: text)]),
            ("Desk, typing", ask["ask-text"]!, [P(name: "Ink, typed words", token: Tokens.ink, minimum: text),
                                                P(name: "Carrot, the field's focus border", token: Tokens.carrot, minimum: mark)]),
            ("Desk, planning", ask["ask-planning"]!, [P(name: "Ink 2, Planning", token: Tokens.ink2, minimum: text)]),
            ("Desk, plan", ask["ask-proposal-in-list"]!, [P(name: "Ink, plan title, steps, row titles", token: Tokens.ink, minimum: text),
                                                         P(name: "Ink 2, group heads, row lines, keys, footer", token: Tokens.ink2, minimum: text),
                                                         P(name: "Carrot text, You do this", token: Tokens.carrotText, minimum: text),
                                                         P(name: "Carrot, needs-you edge", token: Tokens.carrot, minimum: mark),
                                                         P(name: "Ink 3, to-do ring", token: Tokens.ink3, minimum: mark),
                                                         P(name: "On ink, Continue", token: Tokens.onInk, minimum: text)]),
            ("Desk, running", ask["ask-running"]!, [P(name: "Carrot, the lit step", token: Tokens.carrot, minimum: mark),
                                                    P(name: "Ink 2, done check and Working in", token: Tokens.ink2, minimum: text)]),
            ("Desk, failed", ask["ask-failed-untraced"]!, [P(name: "Ink, why there is no plan", token: Tokens.ink, minimum: text)]),
            ("Desk, activity", act["activity-list"]!, [P(name: "Ink, row titles, key buttons", token: Tokens.ink, minimum: text),
                                                      P(name: "Ink 2, row lines", token: Tokens.ink2, minimum: text)]),
            ("Desk, Not right", desk["desk-not-right"]!, [P(name: "Ink 2, source and hint", token: Tokens.ink2, minimum: text)]),
            ("Slip, source", slips["slip-provenance"]!, [P(name: "Ink 2, from what Caret noticed", token: Tokens.ink2, minimum: text),
                                                         P(name: "Ink, Not right", token: Tokens.ink, minimum: text)]),
            ("Slip, correcting", slips["slip-not-right"]!, [P(name: "Ink, typed correction and Forget", token: Tokens.ink, minimum: text),
                                                            P(name: "On ink, Save", token: Tokens.onInk, minimum: text)]),
            ("Rim caption", rim["rim-working"]!, [P(name: "Ink, caption", token: Tokens.ink, minimum: text),
                                                  P(name: "Ink 2, step count", token: Tokens.ink2, minimum: text),
                                                  // Decorative: the caption says in words what the ring shows, and the figure and
                                                  // the glyph show it too. Recorded, not gated: its weakest stretch is where it
                                                  // passes through the perched figure's own glow.
                                                  P(name: "Carrot, ring (decorative)", token: Tokens.carrot, minimum: 0)]),
            ("Rim, stopped", rim["rim-stopped"]!, [P(name: "Graphite, ring (decorative)", token: Tokens.graphite, minimum: 0)]),
            ("Knows, memory", knows["knows-noticed"]!, [P(name: "Ink, title and row titles", token: Tokens.ink, minimum: text),
                                                        P(name: "Ink 2, subtitle, heads, lines, Noticed in, Edit", token: Tokens.ink2, minimum: text),
                                                        P(name: "Carrot, current tab", token: Tokens.carrot, minimum: mark)]),
            ("Knows, Not right", knows["knows-not-right"]!, [P(name: "Ink, correction and buttons", token: Tokens.ink, minimum: text),
                                                             P(name: "On ink, Save", token: Tokens.onInk, minimum: text)]),
            ("Knows, file", knows["knows-file-open"]!, [P(name: "Ink, the file's text", token: Tokens.ink, minimum: text)]),
            ("Knows, conflict", knows["knows-file-conflict"]!, [P(name: "Ink, what changed", token: Tokens.ink, minimum: text),
                                                                P(name: "Ink 2, Reload or Keep my text", token: Tokens.ink2, minimum: text),
                                                                P(name: "On ink, Keep my text", token: Tokens.onInk, minimum: text)]),
            ("Knows, file problem", knows["knows-file-problem"]!, [P(name: "Ink, file, line and field", token: Tokens.ink, minimum: text),
                                                                   P(name: "Carrot, the problem's edge", token: Tokens.carrot, minimum: mark)]),
            ("Knows, permissions", memory["memory-permissions"]!, [P(name: "Ink, rule names, pop-up values", token: Tokens.ink, minimum: text),
                                                                   P(name: "Ink 2, what each rule means, the ceiling", token: Tokens.ink2, minimum: text)]),
            // v2/access replaced the welcome and work screens these rows measured. The new panes need their own probes from
            // the screens' owner; guessed ones measured the Hello headline at 2.88 (v2/next, CI run 37906771739).
        ]
    }

    func testEveryNewTextAndMarkMeetsItsContrastInBothThemes() throws {
        var table = ["| Surface | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, view, probes) in Self.surfaces() {
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
                let needs = probe.minimum == 4.5 ? "4.5 text" : probe.minimum == 3 ? "3 mark" : "not gated"
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | \(needs) |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-u2.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }
}
