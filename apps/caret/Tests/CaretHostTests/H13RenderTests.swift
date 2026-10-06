import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H13's states against their references, light and dark: inline text in a web field, the quiet line about Gmail's
/// own suggestions, the line about a Google Doc whose text is off. Contrast is measured from rendered pixels: the
/// lines' tokens as `ContrastRenderTests` measures them, and the inline text against its own field by rendering the
/// field with and without it.
@MainActor
final class H13RenderTests: XCTestCase {
    func testH13StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h13())
    }

    func testTheLinesTextMeetsItsContrastInBothThemes() throws {
        let views = Dictionary(uniqueKeysWithValues: Gallery.h13().map { ($0.name, $0.view) })
        var table = ["| Surface | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, name) in [("Gmail line", "page-inline-gmail"), ("Docs line", "page-inline-docs-off")] {
            for probe in [ContrastRenderTests.Probe(name: "Ink, the sentence", token: Tokens.ink, minimum: 4.5),
                          ContrastRenderTests.Probe(name: "Ink 2, keys and labels", token: Tokens.ink2, minimum: 4.5)] {
                var cells: [String] = []
                for dark in [false, true] {
                    for (ground, hex) in ContrastRenderTests.grounds {
                        let ratio = try ContrastRenderTests.measure(views[name]!, token: probe.token, dark: dark, canvas: hex)
                        cells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
                        if let ratio, ratio < probe.minimum { failures.append("\(surface), \(probe.name), \(dark ? "dark" : "light") over \(ground): \(String(format: "%.2f", ratio))") }
                        if ratio == nil { failures.append("\(surface), \(probe.name): nothing drawn in that token") }
                    }
                }
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | 4.5 text |")
            }
        }
        // The inline text over its own field: a light page in the light render, a dark page in the dark one.
        var ghostCells: [String] = []
        for dark in [false, true] {
            let shown = AnyView(Gallery.PageFieldScene(typed: Gallery.h13Typed, ghost: Gallery.h13Ghost))
            let hidden = AnyView(Gallery.PageFieldScene(typed: Gallery.h13Typed, ghost: Gallery.h13Ghost, ghostHidden: true))
            let ratio = try Self.weakest(shown: shown, hidden: hidden, dark: dark)
            ghostCells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
            // Ghost text is faint on purpose, as native ghost text is (Tokens.ghostOpacity): it must still read as a mark.
            if let ratio, ratio < 3.0 { failures.append("Inline text, \(dark ? "dark" : "light") page: \(String(format: "%.2f", ratio))") }
            if ratio == nil { failures.append("Inline text: nothing drawn") }
        }
        table.append("| Inline text | Page ink at ghost opacity, over its field | \(ghostCells[0]) (light page) | | \(ghostCells[1]) (dark page) | | 3 mark |")
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-h13.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    func testTheLinesWords() {
        XCTAssertEqual(PageInlineCopy.notice(.gmail).question?.hints.map(\.label), ["Turn Caret on here", "Don't show again", "Not now"])
        XCTAssertFalse(PageInlineCopy.gmail.contains("—"))
        // What VoiceOver hears for a fresh suggestion (prep-for-prod): the words and the key.
        XCTAssertEqual(PageInlineCopy.spoken(" Field Robotics Technician role"), "Suggestion: Field Robotics Technician role. Tab accepts it.")
        XCTAssertFalse(PageInlineCopy.sitesIntro.contains("—"))
    }

    /// The weakest contrast of any shape `shown` draws over what `hidden` draws there, from pixels, as
    /// `ContrastRenderTests.measure` does for a token.
    static func weakest(shown: AnyView, hidden: AnyView, dark: Bool) throws -> Double? {
        let a = try Pixels(XCTUnwrap(Gallery.png(shown, dark: dark)))
        let b = try Pixels(XCTUnwrap(Gallery.png(hidden, dark: dark)))
        precondition(a.width == b.width && a.height == b.height)
        var changed = [Bool](repeating: false, count: a.width * a.height)
        for i in changed.indices where Pixels.distance(a.rgb(i), b.rgb(i)) > 6 { changed[i] = true }
        var seen = [Bool](repeating: false, count: changed.count)
        var weakest: Double?
        for start in changed.indices where changed[start] && !seen[start] {
            var stack = [start], members: [Int] = []
            seen[start] = true
            while let i = stack.popLast() {
                members.append(i)
                let x = i % a.width, y = i / a.width
                for dy in -1...1 { for dx in -1...1 {
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < a.width, ny < a.height else { continue }
                    let j = ny * a.width + nx
                    if changed[j] && !seen[j] { seen[j] = true; stack.append(j) }
                }}
            }
            guard members.count >= 6 else { continue }
            let best = members.map { Pixels.contrast(a.rgb($0), b.rgb($0)) }.max() ?? 0
            weakest = min(weakest ?? .infinity, best)
        }
        return weakest
    }
}
