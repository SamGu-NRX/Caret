import AppKit
import XCTest
@testable import CaretHost

/// What Increase Contrast does to the tokens: every variant must strictly raise the WCAG ratio on
/// each surface the token stands on — the window, the card, and the glass composited over the
/// opposite theme's document (`Tokens.swift`'s worst case), with the glass at its own increased
/// alphas — and tokens without a variant must resolve to exactly the color they had.
///
/// Test-first, against the pre-change `Tokens.swift`, each test here could not pass: line 10
/// declared `dynamic(light:dark:alpha:darkAlpha:)` with no contrast overrides and no
/// `increaseContrast` existed anywhere in the enum, so every test but the last failed to compile
/// (`cannot find 'increaseContrast'`, `extra argument 'contrastLight'` in call); line 72 read
/// `alpha: 0.94, darkAlpha: 0.92`, under this file's 0.97 / 0.95; line 225 read
/// `static func ghostOpacity(dark: Bool) -> Double { dark ? 0.50 : 0.45 }`, under this file's
/// 0.65; and with no flag to raise, a raised color resolved to itself, so every
/// strictly-higher assert would compare a color with itself.
/// `testTokensWithoutVariantsResolveIdentically` is the one guard that also held before the
/// change: it pins the tokens the audit found already over their aims.
@MainActor
final class ContrastIncreaseTests: XCTestCase {
    private func resolved(_ color: NSColor, dark: Bool) throws -> (Double, Double, Double, Double) {
        var out: NSColor?
        NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
            out = color.usingColorSpace(.sRGB)
        }
        let c = try XCTUnwrap(out)
        return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent))
    }

    private func luminance(_ rgb: (Double, Double, Double)) -> Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
    }

    private func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private func rgb(_ c: (Double, Double, Double, Double)) -> (Double, Double, Double) { (c.0, c.1, c.2) }

    /// The three grounds, resolved under the flag as it stands — the glass's own alpha moves with
    /// Increase Contrast, so its composite moves too.
    private func grounds(dark: Bool) throws -> [(String, (Double, Double, Double))] {
        let glass = try resolved(Tokens.glass, dark: dark)
        let backdrop: (Double, Double, Double) = dark ? (1, 1, 1) : (0x1F / 255.0, 0x1F / 255.0, 0x24 / 255.0)
        let worst = (glass.0 * glass.3 + backdrop.0 * (1 - glass.3),
                     glass.1 * glass.3 + backdrop.1 * (1 - glass.3),
                     glass.2 * glass.3 + backdrop.2 * (1 - glass.3))
        return [
            ("the window", rgb(try resolved(Tokens.window, dark: dark))),
            ("the card", rgb(try resolved(Tokens.card, dark: dark))),
            ("the glass's worst case", worst),
        ]
    }

    private func assertSameColor(_ a: (Double, Double, Double, Double), _ b: (Double, Double, Double, Double), _ why: String) {
        XCTAssertEqual(a.0, b.0, accuracy: 1e-6, why)
        XCTAssertEqual(a.1, b.1, accuracy: 1e-6, why)
        XCTAssertEqual(a.2, b.2, accuracy: 1e-6, why)
        XCTAssertEqual(a.3, b.3, accuracy: 1e-6, why)
    }

    /// A variant must strictly raise the ratio on every ground and meet its aim on the worst one.
    private func assertRaised(_ color: NSColor, dark: Bool, aim: Double, _ name: String) throws {
        Tokens.increaseContrast = false
        defer { Tokens.increaseContrast = false }
        let base = try resolved(color, dark: dark)
        let baseGrounds = try grounds(dark: dark)
        Tokens.increaseContrast = true
        let raised = try resolved(color, dark: dark)
        let raisedGrounds = try grounds(dark: dark)
        for ((ground, bgBase), (_, bgRaised)) in zip(baseGrounds, raisedGrounds) {
            let before = contrast(rgb(base), bgBase)
            let after = contrast(rgb(raised), bgRaised)
            XCTAssertGreaterThan(after, before, "\(name) on \(ground), dark \(dark): Increase Contrast must raise the ratio")
            XCTAssertGreaterThanOrEqual(after, aim, "\(name) on \(ground), dark \(dark): the variant's aim")
        }
    }

    func testInk2ReachesSevenToOneOnEveryGround() throws {
        try assertRaised(Tokens.ink2, dark: false, aim: 7, "Ink 2")
        try assertRaised(Tokens.ink2, dark: true, aim: 7, "Ink 2")
    }

    func testInk3ReachesFourAndAHalfOnEveryGround() throws {
        try assertRaised(Tokens.ink3, dark: false, aim: 4.5, "Ink 3")
        try assertRaised(Tokens.ink3, dark: true, aim: 4.5, "Ink 3")
    }

    /// Carrot only gained a light variant: the audit found the dark value already over 4.5:1
    /// (6.1:1 on the worst dark ground).
    func testCarrotReachesFourAndAHalfOnLight() throws {
        try assertRaised(Tokens.carrot, dark: false, aim: 4.5, "Carrot")
    }

    func testCarrotTextReachesSixOnLight() throws {
        try assertRaised(Tokens.carrotText, dark: false, aim: 6, "Carrot Text")
    }

    func testGlassGainsOpacityAndKeepsItsTint() throws {
        Tokens.increaseContrast = false
        defer { Tokens.increaseContrast = false }
        let base = try resolved(Tokens.glass, dark: false)
        let baseDark = try resolved(Tokens.glass, dark: true)
        Tokens.increaseContrast = true
        let raised = try resolved(Tokens.glass, dark: false)
        let raisedDark = try resolved(Tokens.glass, dark: true)
        for (b, r, theme) in [(base, raised, "light"), (baseDark, raisedDark, "dark")] {
            XCTAssertEqual(b.0, r.0, accuracy: 1e-6, "the tint must not move, \(theme)")
            XCTAssertEqual(b.1, r.1, accuracy: 1e-6, "the tint must not move, \(theme)")
            XCTAssertEqual(b.2, r.2, accuracy: 1e-6, "the tint must not move, \(theme)")
            XCTAssertGreaterThan(r.3, b.3, "the increased glass is more opaque, \(theme)")
        }
        XCTAssertEqual(raised.3, 0.97, accuracy: 0.0005, "light alpha")
        XCTAssertEqual(raisedDark.3, 0.95, accuracy: 0.0005, "dark alpha")
    }

    /// The ticked box's check: white on Carrot is 3.9:1 light — a state needs 3:1 (WCAG 1.4.11),
    /// and Increase Contrast's darkened Carrot carries it to the text-level 4.5:1.
    func testTheBoxCheckReachesFourAndAHalfOnTheIncreasedCarrot() throws {
        Tokens.increaseContrast = false
        defer { Tokens.increaseContrast = false }
        let fill = try resolved(Tokens.carrot, dark: false)
        let check = try resolved(Tokens.onCarrot, dark: false)
        Tokens.increaseContrast = true
        let raisedFill = try resolved(Tokens.carrot, dark: false)
        let raisedCheck = try resolved(Tokens.onCarrot, dark: false)
        let before = contrast(rgb(check), rgb(fill))
        let after = contrast(rgb(raisedCheck), rgb(raisedFill))
        XCTAssertGreaterThan(after, before, "the darkened Carrot must raise the check's ratio")
        XCTAssertGreaterThanOrEqual(after, 4.5)
    }

    func testGhostOpacityIsSixtyFiveHundredthsOnBothThemes() {
        XCTAssertEqual(Tokens.ghostOpacity(dark: false), 0.65, accuracy: 0.0001)
        XCTAssertEqual(Tokens.ghostOpacity(dark: true), 0.65, accuracy: 0.0001)
        // The reference composites: the host's black on a white field, white on a #1E1E1E field.
        func ghostRatio(_ fg: Double, _ bg: Double, dark: Bool) -> Double {
            let a = Tokens.ghostOpacity(dark: dark)
            let c = fg * a + bg * (1 - a)
            return contrast((c, c, c), (bg, bg, bg))
        }
        XCTAssertGreaterThanOrEqual(ghostRatio(0, 1, dark: false), 4.5, "black ghost on a white field")
        XCTAssertGreaterThanOrEqual(ghostRatio(1, 0x1E / 255.0, dark: true), 4.5, "white ghost on a #1E1E1E field")
    }

    /// Tokens without a variant resolve to exactly the color they had — including Carrot's dark
    /// value, which the audit found already over its aim.
    func testTokensWithoutVariantsResolveIdentically() throws {
        for dark in [false, true] {
            for (token, name) in [(Tokens.ink, "ink"), (Tokens.onInk, "onInk"), (Tokens.onCarrot, "onCarrot"),
                                  (Tokens.graphite, "graphite"), (Tokens.window, "window"), (Tokens.card, "card"),
                                  (Tokens.inkFill, "inkFill")] {
                Tokens.increaseContrast = false
                let base = try resolved(token, dark: dark)
                Tokens.increaseContrast = true
                let raised = try resolved(token, dark: dark)
                Tokens.increaseContrast = false
                assertSameColor(base, raised, "\(name) has no variant, dark \(dark)")
            }
            if dark {
                Tokens.increaseContrast = false
                let base = try resolved(Tokens.carrot, dark: true)
                Tokens.increaseContrast = true
                let raised = try resolved(Tokens.carrot, dark: true)
                Tokens.increaseContrast = false
                assertSameColor(base, raised, "Carrot dark has no variant")
            }
        }
    }
}
