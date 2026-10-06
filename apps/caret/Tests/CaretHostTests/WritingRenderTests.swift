import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// The writing offer's renders, its contrast, and its copy.
@MainActor
final class WritingRenderTests: XCTestCase {
    /// The mark, the line, the alternatives open on the fix and on Fix all, and the toast, in light
    /// and dark, against committed references (`SnapshotTests.check`).
    func testWritingRendersMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.writing())
    }

    // MARK: - Contrast

    /// WCAG 2 contrast of `color` (composited over `background`) against `background`.
    static func contrast(_ color: NSColor, over background: UInt32, dark: Bool, under: NSColor? = nil) -> Double {
        let bg = composite(under, over: rgb(background), dark: dark)
        let fg = composite(color, over: bg, dark: dark)
        let (l1, l2) = (luminance(fg), luminance(bg))
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    static func rgb(_ hex: UInt32) -> (Double, Double, Double) {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }

    /// `color` resolved in the appearance and laid over `base` by its alpha.
    static func composite(_ color: NSColor?, over base: (Double, Double, Double), dark: Bool) -> (Double, Double, Double) {
        guard let color else { return base }
        var resolved = color
        NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB)!
        }
        let a = Double(resolved.alphaComponent)
        return (
            Double(resolved.redComponent) * a + base.0 * (1 - a),
            Double(resolved.greenComponent) * a + base.1 * (1 - a),
            Double(resolved.blueComponent) * a + base.2 * (1 - a)
        )
    }

    static func luminance(_ c: (Double, Double, Double)) -> Double {
        func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.0) + 0.7152 * lin(c.1) + 0.0722 * lin(c.2)
    }

    /// Field backgrounds the mark is drawn over: white (TextEdit, Mail), the light window gray, and
    /// three dark grounds (TextEdit dark, the dark panel, a raised dark field).
    static let lightFields: [UInt32] = [0xFFFFFF, 0xF5F5F7, 0xECECEC]
    static let darkFields: [UInt32] = [0x1E1E1E, 0x2C2C2E, 0x3A3A3C]

    func testTheMarkReachesThreeToOneOnFieldBackgrounds() {
        var rows: [String] = []
        for (dark, fields) in [(false, Self.lightFields), (true, Self.darkFields)] {
            for field in fields {
                for (name, increased, active) in [("active", false, true), ("other", false, false), ("active, Increase Contrast", true, true)] {
                    let ratio = Self.contrast(WritingMark.color(active: active, increasedContrast: increased), over: field, dark: dark)
                    rows.append(String(format: "%@ mark on #%06X: %.2f:1", name, field, ratio))
                    XCTAssertGreaterThanOrEqual(ratio, 3, rows.last!)
                }
            }
        }
        print(rows.joined(separator: "\n"))
    }

    /// Text in the line and the open list: Ink and Secondary on the panel surface, and on the
    /// highlighted row's wash, over the light and dark canvases the renders use.
    func testPanelTextReachesFourPointFiveToOne() {
        var rows: [String] = []
        for (dark, canvas) in [(false, UInt32(0xECECEE)), (true, UInt32(0x1E1E20))] {
            // The writing rows set every word on the highlight in Ink; Secondary appears only on
            // the plain surface.
            for (surfaceName, surface, texts) in [
                ("surface", nil as NSColor?, [("Ink", Tokens.ink), ("Secondary", Tokens.secondary)]),
                ("highlighted row", Tokens.carrotWash, [("Ink", Tokens.ink)]),
            ] {
                for (textName, text) in texts {
                    // The surface over the canvas, the wash over that, then the text.
                    let base = Self.composite(Tokens.surface, over: Self.rgb(canvas), dark: dark)
                    let ground = Self.composite(surface, over: base, dark: dark)
                    let fg = Self.composite(text, over: ground, dark: dark)
                    let (l1, l2) = (Self.luminance(fg), Self.luminance(ground))
                    let ratio = (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
                    rows.append(String(format: "%@ on %@ (%@): %.2f:1", textName, surfaceName, dark ? "dark" : "light", ratio))
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, rows.last!)
                }
            }
        }
        print(rows.joined(separator: "\n"))
    }

    // MARK: - Copy

    /// The copy rules of `CopyRulesTests`, over the writing files: no em or en dashes, no
    /// exclamation marks, no all-caps words.
    func testWritingCopyFollowsTheRules() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources").standardized
        var checked = 0
        for file in ["CaretHostCore/Writing/WritingCopy.swift", "CaretHost/Writing/WritingViews.swift"] {
            let text = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
            let code = text.split(separator: "\n", omittingEmptySubsequences: false)
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                .joined(separator: "\n")
            let pattern = try NSRegularExpression(pattern: #""((?:[^"\\\n]|\\.)*)""#)
            for match in pattern.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
                guard let range = Range(match.range(at: 1), in: code) else { continue }
                let literal = String(code[range])
                guard literal.contains(where: \.isLetter) else { continue }
                checked += 1
                XCTAssertFalse(literal.contains("\u{2014}") || literal.contains("\u{2013}"), "dash in \(file): \(literal)")
                XCTAssertFalse(literal.contains("!"), "exclamation mark in \(file): \(literal)")
                let letters = literal.filter(\.isLetter)
                XCTAssertFalse(letters.count >= 3 && letters == letters.uppercased(), "all caps in \(file): \(literal)")
            }
        }
        XCTAssertGreaterThan(checked, 20)
    }
}
