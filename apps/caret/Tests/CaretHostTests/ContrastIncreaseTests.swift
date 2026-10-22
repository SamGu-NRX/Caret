import AppKit
import XCTest
@testable import CaretHost

typealias RGBA = (Double, Double, Double, Double)

/// Colors as these tests compare them. AppKit builds an Increase Contrast appearance only for the
/// system (NSAppearance.h: the accessibility names passed to `appearanceNamed:` return nil, and
/// `initWithAppearanceNamed:bundle:` returns nil under XCTest), so Increase Contrast is resolved
/// through `Tokens.Shade.resolve`, the function every token's color calls with the appearance's variant.
enum TokenColors {
    /// `color` in the standard light or dark appearance. The drawing appearance is restored on return.
    static func resolved(_ color: NSColor, dark: Bool) throws -> RGBA {
        var out: NSColor?
        try XCTUnwrap(NSAppearance(named: dark ? .darkAqua : .aqua)).performAsCurrentDrawingAppearance {
            out = color.usingColorSpace(.sRGB)
        }
        let c = try XCTUnwrap(out)
        return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent))
    }

    static func resolved(_ shade: Tokens.Shade, dark: Bool, highContrast: Bool) -> RGBA {
        let value = shade.resolve(.init(dark: dark, highContrast: highContrast))
        return (Double((value.hex >> 16) & 0xFF) / 255, Double((value.hex >> 8) & 0xFF) / 255,
                Double(value.hex & 0xFF) / 255, Double(value.alpha))
    }

    static func luminance(_ c: RGBA) -> Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(c.0) + 0.7152 * linear(c.1) + 0.0722 * linear(c.2)
    }

    /// The WCAG ratio of two colors' RGB; alpha is composited by the caller (`over`).
    static func contrast(_ a: RGBA, _ b: RGBA) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    static func over(_ c: RGBA, _ ground: RGBA) -> RGBA {
        (c.0 * c.3 + ground.0 * (1 - c.3), c.1 * c.3 + ground.1 * (1 - c.3), c.2 * c.3 + ground.2 * (1 - c.3), 1)
    }
}

/// Increase Contrast variants raise the WCAG ratio while normal appearance values remain unchanged.
@MainActor
final class ContrastIncreaseTests: XCTestCase {
    private typealias C = TokenColors

    /// The three grounds. Window and card have no variant; the glass's own alpha moves with
    /// Increase Contrast, so its composite over the opposite theme's document moves too.
    private func grounds(dark: Bool, highContrast: Bool) throws -> [(String, RGBA)] {
        let glass = C.resolved(Tokens.Shades.glass, dark: dark, highContrast: highContrast)
        let backdrop: RGBA = dark ? (1, 1, 1, 1) : (0x1F / 255.0, 0x1F / 255.0, 0x24 / 255.0, 1)
        return [
            ("the window", try C.resolved(Tokens.window, dark: dark)),
            ("the card", try C.resolved(Tokens.card, dark: dark)),
            ("the glass's worst case", C.over(glass, backdrop)),
        ]
    }

    /// A variant must strictly raise the ratio on every ground and meet its aim on the worst one.
    private func assertRaised(_ shade: Tokens.Shade, dark: Bool, aim: Double, _ name: String) throws {
        let base = C.resolved(shade, dark: dark, highContrast: false)
        let raised = C.resolved(shade, dark: dark, highContrast: true)
        for ((ground, bgBase), (_, bgRaised)) in zip(try grounds(dark: dark, highContrast: false), try grounds(dark: dark, highContrast: true)) {
            let before = C.contrast(base, bgBase)
            let after = C.contrast(raised, bgRaised)
            XCTAssertGreaterThan(after, before, "\(name) on \(ground), dark \(dark): Increase Contrast must raise the ratio")
            XCTAssertGreaterThanOrEqual(after, aim, "\(name) on \(ground), dark \(dark): the variant's aim")
        }
    }

    private func assertSame(_ a: RGBA, _ b: RGBA, _ why: String) {
        XCTAssertEqual(a.0, b.0, accuracy: 1e-6, why)
        XCTAssertEqual(a.1, b.1, accuracy: 1e-6, why)
        XCTAssertEqual(a.2, b.2, accuracy: 1e-6, why)
        XCTAssertEqual(a.3, b.3, accuracy: 1e-6, why)
    }

    // MARK: From the appearance to a value

    func testTheStandardAppearancesReadAsNormalContrast() throws {
        XCTAssertEqual(Tokens.Variant(try XCTUnwrap(NSAppearance(named: .aqua))), .init(dark: false, highContrast: false))
        XCTAssertEqual(Tokens.Variant(try XCTUnwrap(NSAppearance(named: .darkAqua))), .init(dark: true, highContrast: false))
    }

    /// The colors are built from the shades the ratio tests below check, so Increase Contrast
    /// reaches them through the same provider as the theme.
    func testEveryContrastedTokenDrawsItsShade() throws {
        let pairs: [(NSColor, Tokens.Shade, String)] = [
            (Tokens.ink2, Tokens.Shades.ink2, "Ink 2"), (Tokens.ink3, Tokens.Shades.ink3, "Ink 3"),
            (Tokens.carrot, Tokens.Shades.carrot, "Carrot"), (Tokens.carrotText, Tokens.Shades.carrotText, "Carrot Text"),
            (Tokens.glass, Tokens.Shades.glass, "Glass"),
        ]
        for (token, shade, name) in pairs {
            for dark in [false, true] {
                assertSame(try C.resolved(token, dark: dark), C.resolved(shade, dark: dark, highContrast: false), "\(name), dark \(dark)")
            }
        }
    }

    /// The pure resolution: each of the four variants picks its own value, and a missing contrast
    /// value falls back to the normal one for that theme.
    func testAShadeResolvesEachVariantAndFallsBackToItsNormalValue() {
        let full = Tokens.Shade(light: 0x111111, dark: 0x222222, alpha: 0.5, darkAlpha: 0.6,
                                contrastLight: 0x333333, contrastDark: 0x444444, contrastAlpha: 0.7, contrastDarkAlpha: 0.8)
        let cases: [(Bool, Bool, UInt32, CGFloat)] = [
            (false, false, 0x111111, 0.5), (true, false, 0x222222, 0.6),
            (false, true, 0x333333, 0.7), (true, true, 0x444444, 0.8),
        ]
        for (dark, highContrast, hex, alpha) in cases {
            let value = full.resolve(.init(dark: dark, highContrast: highContrast))
            XCTAssertEqual(value.hex, hex, "dark \(dark), high contrast \(highContrast)")
            XCTAssertEqual(value.alpha, alpha, "dark \(dark), high contrast \(highContrast)")
        }
        let bare = Tokens.Shade(light: 0x111111, dark: 0x222222, alpha: 0.5, darkAlpha: 0.6)
        for dark in [false, true] {
            XCTAssertTrue(bare.resolve(.init(dark: dark, highContrast: true)) == bare.resolve(.init(dark: dark, highContrast: false)),
                          "a token without a variant keeps its normal value, dark \(dark)")
        }
        let lightOnly = Tokens.Shade(light: 0x111111, dark: 0x222222, alpha: 0.5, contrastLight: 0x333333, contrastAlpha: 0.7)
        XCTAssertTrue(lightOnly.resolve(.init(dark: true, highContrast: true)) == (0x222222, 0.5),
                      "a light-only variant leaves the dark value alone")
    }

    // MARK: Ratios

    func testInk2ReachesSevenToOneOnEveryGround() throws {
        try assertRaised(Tokens.Shades.ink2, dark: false, aim: 7, "Ink 2")
        try assertRaised(Tokens.Shades.ink2, dark: true, aim: 7, "Ink 2")
    }

    func testInk3ReachesFourAndAHalfOnEveryGround() throws {
        try assertRaised(Tokens.Shades.ink3, dark: false, aim: 4.5, "Ink 3")
        try assertRaised(Tokens.Shades.ink3, dark: true, aim: 4.5, "Ink 3")
    }

    /// Carrot only gained a light variant: the audit found the dark value already over 4.5:1
    /// (6.1:1 on the worst dark ground).
    func testCarrotReachesFourAndAHalfOnLight() throws {
        try assertRaised(Tokens.Shades.carrot, dark: false, aim: 4.5, "Carrot")
    }

    func testCarrotTextReachesSixOnLight() throws {
        try assertRaised(Tokens.Shades.carrotText, dark: false, aim: 6, "Carrot Text")
    }

    func testGlassGainsOpacityAndKeepsItsTint() {
        for dark in [false, true] {
            let base = C.resolved(Tokens.Shades.glass, dark: dark, highContrast: false)
            let raised = C.resolved(Tokens.Shades.glass, dark: dark, highContrast: true)
            assertSame((base.0, base.1, base.2, 0), (raised.0, raised.1, raised.2, 0), "the tint must not move, dark \(dark)")
            XCTAssertGreaterThan(raised.3, base.3, "the increased glass is more opaque, dark \(dark)")
        }
    }

    /// The ticked box's check: white on Carrot is 3.9:1 light — a state needs 3:1 (WCAG 1.4.11),
    /// and Increase Contrast's darkened Carrot carries it to the text-level 4.5:1.
    func testTheBoxCheckReachesFourAndAHalfOnTheIncreasedCarrot() throws {
        let check = try C.resolved(Tokens.onCarrot, dark: false)
        let before = C.contrast(check, C.resolved(Tokens.Shades.carrot, dark: false, highContrast: false))
        let after = C.contrast(check, C.resolved(Tokens.Shades.carrot, dark: false, highContrast: true))
        XCTAssertGreaterThan(after, before, "the darkened Carrot must raise the check's ratio")
        XCTAssertGreaterThanOrEqual(after, 4.5)
    }

    // MARK: Ghost text

    func testGhostOpacityKeepsItsNormalValuesAndRaisesUnderIncreaseContrast() {
        XCTAssertEqual(Tokens.ghostOpacity(darkField: false, highContrast: false), 0.45)
        XCTAssertEqual(Tokens.ghostOpacity(darkField: true, highContrast: false), 0.50)
        XCTAssertEqual(Tokens.ghostOpacity(darkField: false, highContrast: true), 0.65)
        XCTAssertEqual(Tokens.ghostOpacity(darkField: true, highContrast: true), 0.65)
    }

    /// Callers pass only the host's ink and the field's theme. The field's theme, not Caret's, picks
    /// the normal value, since a light field can sit under a dark system; the opacity replaces the
    /// ink's own alpha, so a translucent system color draws at the same weight.
    func testGhostInkDrawsTheHostsInkAtTheFieldsOpacity() throws {
        for dark in [false, true] {
            for darkField in [false, true] {
                let ink = try C.resolved(Tokens.ghostInk(.black, darkField: darkField), dark: dark)
                assertSame(ink, (0, 0, 0, darkField ? 0.50 : 0.45), "dark \(dark), dark field \(darkField)")
            }
        }
        XCTAssertEqual(try C.resolved(Tokens.ghostInk(.labelColor, darkField: false), dark: false).3, 0.45, accuracy: 1e-6)
    }

    /// Ghost text on its own field: black on a white field, white on a #1E1E1E one. Normal contrast
    /// keeps ghost text faint on purpose; Increase Contrast lifts it to text contrast.
    func testGhostTextReachesFourAndAHalfOnItsFieldUnderIncreaseContrast() {
        for (darkField, ink, field) in [(false, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), (true, (1.0, 1.0, 1.0), (0x1E / 255.0, 0x1E / 255.0, 0x1E / 255.0))] {
            let ground: RGBA = (field.0, field.1, field.2, 1)
            func drawn(_ highContrast: Bool) -> RGBA {
                C.over((ink.0, ink.1, ink.2, Double(Tokens.ghostOpacity(darkField: darkField, highContrast: highContrast))), ground)
            }
            let (before, after) = (C.contrast(drawn(false), ground), C.contrast(drawn(true), ground))
            XCTAssertGreaterThan(after, before, "dark field \(darkField)")
            XCTAssertGreaterThanOrEqual(after, 4.5, "dark field \(darkField)")
        }
    }
}
