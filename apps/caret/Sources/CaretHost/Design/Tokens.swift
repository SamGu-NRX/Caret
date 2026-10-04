import AppKit
import SwiftUI

/// Caret's design tokens, v3 (`design/v3/DIRECTION.md` section 3): one source of truth for type,
/// color, shape and motion that every surface reads.
///
/// The figure is the only colored thing Caret draws, rendered as light; everything around it is
/// uncolored glass. Where a value differs from DIRECTION.md, the reason is at the value.
enum Tokens {
    static func dynamic(light: UInt32, dark: UInt32, alpha: CGFloat = 1, darkAlpha: CGFloat? = nil) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return srgb(isDark ? dark : light, alpha: isDark ? (darkAlpha ?? alpha) : alpha)
        }
    }

    static func srgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    // MARK: Ink

    // Contrast below is the WCAG ratio against the glass composited over the opposite theme's
    // document, the worst case: light glass over a #1F1F24 editor, dark glass over a white page.
    // `TokenContrastTests` holds these; `ContrastRenderTests` measures them from rendered pixels.

    /// Panel text. 14.6:1 light, 10.6:1 dark, worst case.
    static let ink = dynamic(light: 0x1C1B19, dark: 0xF2EFEA)
    /// Secondary text, hints, glyphs. DIRECTION.md has `#6B6864` / `#A39F98`, which fall to 4.2:1
    /// and 3.8:1 over the opposite theme's document; these reach 5.4:1 and 5.1:1.
    static let ink2 = dynamic(light: 0x625F5B, dark: 0xABA7A0)
    /// Marks only, never text: idle ticks, idle dots, placeholders' rules. DIRECTION.md has
    /// `#A39F98` / `#6F6B65`, 2.0:1 and 1.9:1 worst case, under the 3:1 a mark that carries a
    /// count needs (WCAG 1.4.11); these are 3.4:1 and 3.1:1.
    static let ink3 = dynamic(light: 0x857F79, dark: 0x85817A)

    // MARK: The light

    /// The underline, the ticks, the lit step, the step bar, the chosen row's edge. DIRECTION.md's
    /// light `#D9641E` measured 2.96:1 as the step bar over light glass on a dark editor (rendered
    /// pixels, `ContrastRenderTests`), under the 3:1 a mark that carries progress needs; `#D35E19`
    /// is 3.3:1 there with almost no change of hue.
    static let carrot = dynamic(light: 0xD35E19, dark: 0xF49A5B)
    /// The first word of a result ("Added", "Filled"), "On its own:". DIRECTION.md's light
    /// `#B24F12` is 4.4:1 over light glass on a dark document; `#A9490F` is 4.9:1.
    static let carrotText = dynamic(light: 0xA9490F, dark: 0xF8A86D)
    /// The 400 ms flash on a filled field. Never a row background: T1 measured Ink 2 on it at
    /// 4.47:1 light and 4.20:1 dark.
    static let carrotWash = dynamic(light: 0xD9641E, dark: 0xF49A5B, alpha: 0.09, darkAlpha: 0.12)
    /// The figure's drop shadow and the warm cast behind it.
    static let glow = dynamic(light: 0xEC7E34, dark: 0xF49A5B, alpha: 0.26, darkAlpha: 0.40)
    /// The figure's radial gradient, center (38%, 30%), radius 78%.
    static let skinCore = dynamic(light: 0xFFC98A, dark: 0xFFD6A4)
    static let skinMid = dynamic(light: 0xEE8238, dark: 0xF49A5B)
    static let skinRim = dynamic(light: 0xCC5A19, dark: 0xD16B28)
    /// The error figure; the menu bar glyph at rest. 3.1:1 and 3.4:1 worst case, for a mark.
    static let graphite = dynamic(light: 0x8A8782, dark: 0x8E8A84)
    /// The figure's eyes, dark on the lit body in both themes.
    static let eye = srgb(0x1D1D1F)

    // MARK: Glass

    /// The glass's warm-neutral tint, laid over the system material on screen (DIRECTION.md
    /// section 7) and drawn alone in off-screen renders. DIRECTION.md's 0.88 / 0.86 let a document
    /// of the opposite theme pull Ink 2 under 4.5:1; 0.94 / 0.92 keep every text token above it.
    /// Because the tint covers the material, the rendered-pixel contrast holds over any backdrop.
    static let glass = dynamic(light: 0xFAF9F7, dark: 0x262422, alpha: 0.94, darkAlpha: 0.92)
    /// 1 pt ring on every panel.
    static let glassEdge = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.10, darkAlpha: 0.12)
    /// 1 pt inset line along the top edge.
    static let glassHighlight = dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, alpha: 0.75, darkAlpha: 0.08)
    /// Hairlines inside panels and windows.
    static let rule = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.08, darkAlpha: 0.09)
    /// Keycaps and secondary buttons.
    static let keyFill = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.035, darkAlpha: 0.06)
    static let keyEdge = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.13, darkAlpha: 0.16)

    // MARK: Names the writing views read (T2's `CaretHost/Writing`), kept so they adopt v3
    // without an edit there. New code uses the names above.

    static var secondary: NSColor { ink2 }
    static var border: NSColor { rule }
    static var keycapBorder: NSColor { keyEdge }
    static var surface: NSColor { glass }

    // MARK: Caret's own windows (onboarding, What Caret knows): restyled in part 2 of v3.

    // Onboarding is Caret's own window, so it paints its own ground rather than the system's
    // `#ECECEC`, on which Ink 2 would be too faint for 12 pt text.
    static let window = dynamic(light: 0xF7F7F8, dark: 0x2A2A2C)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x323234)
    /// The primary button: white on `#B24F12` is 5.22:1; `#1D1D1F` on the dark Carrot is 7.71:1.
    static let buttonFill = dynamic(light: 0xB24F12, dark: 0xF49A5B)
    static let onButton = dynamic(light: 0xFFFFFF, dark: 0x1D1D1F)
    /// The check inside a ticked box, on the Carrot fill.
    static let onCarrot = dynamic(light: 0xFFFFFF, dark: 0x1D1D1F)

    // MARK: Type

    /// Which face Caret's own sentences use (H5). New York unless a render compares the two.
    enum VoiceFace: String, CaseIterable, Sendable {
        case newYork, sfPro
        var design: SwiftUI.Font.Design { self == .newYork ? .serif : .default }
        var nsDesign: NSFontDescriptor.SystemDesign { self == .newYork ? .serif : .default }
    }

    /// Serif where Caret speaks a sentence; SF for a label, a value, a key, a row, or the user's
    /// own words. Sizes and leading from DIRECTION.md section 3.
    enum Font {
        /// 13.5/18 Medium: the offer sentence, working and result captions, the skill question.
        static func voice(_ face: VoiceFace) -> SwiftUI.Font { .system(size: 13.5, weight: .medium, design: face.design) }
        /// The lead word of a result ("Added"), in the voice at semibold.
        static func voiceLead(_ face: VoiceFace) -> SwiftUI.Font { .system(size: 13.5, weight: .semibold, design: face.design) }
        /// 15/20 Medium: pop-up titles.
        static func voiceLarge(_ face: VoiceFace) -> SwiftUI.Font { .system(size: 15, weight: .medium, design: face.design) }
        /// 22/28 Medium, tracking -0.3: onboarding headlines, "What Caret knows".
        static func voiceDisplay(_ face: VoiceFace) -> SwiftUI.Font { .system(size: 22, weight: .medium, design: face.design) }
        /// 12.5/17 Regular: pop-up rows, picker rows, quoted evidence.
        static let chrome = SwiftUI.Font.system(size: 12.5)
        /// 12/15 Regular: app names, metadata, hints, "from Mail, Invoice 2041".
        static let chromeSmall = SwiftUI.Font.system(size: 12)
        /// 11/14 Medium: keycaps, counts.
        static let key = SwiftUI.Font.system(size: 11, weight: .medium)
        /// 13/17 Medium: activity and memory row titles.
        static let row = SwiftUI.Font.system(size: 13, weight: .medium)

        // Names read by surfaces not yet restyled (writing, onboarding, memory, the desk).
        static var body: SwiftUI.Font { chrome }
        static var hint: SwiftUI.Font { chromeSmall }
        static var title: SwiftUI.Font { row }
    }

    // MARK: Shape

    enum Shape {
        /// The slip: 30 tall, radius 9, padding 0 10 0 8.
        static let slipRadius: CGFloat = 9
        static let slipHeight: CGFloat = 30
        static let slipLeading: CGFloat = 8
        static let slipTrailing: CGFloat = 10
        /// The slip with the skill question: a 30 row, a hairline, a 44 row.
        static let slipQuestionRow: CGFloat = 44
        /// The slip at a tight spot (A18's compact line): 20 tall, radius 6.
        static let compactHeight: CGFloat = 20
        static let compactRadius: CGFloat = 6
        /// Figure 14, gap 7, glyph 14, gap 7, sentence, gap 12, keys.
        static let gap: CGFloat = 7
        static let keysGap: CGFloat = 12
        /// The slip never grows past this; a longer sentence is cut at its end.
        static let slipMaxWidth: CGFloat = 520
        /// Pop-ups: radius 12, padding 10 12 9, width 280 to 380.
        static let popupRadius: CGFloat = 12
        static let popupMinWidth: CGFloat = 280
        static let popupMaxWidth: CGFloat = 380
        /// The key column of a pop-up's rows.
        static let keyColumn: CGFloat = 62
        /// Keycap: 17 tall, radius 4, padding 0 5, 1 pt edge with a 1.5 pt bottom edge.
        static let keycapHeight: CGFloat = 17
        static let keycapRadius: CGFloat = 4
        /// The step bar: 2 pt along the slip's bottom edge, inset 9 at each end.
        static let barHeight: CGFloat = 2
        static let barInset: CGFloat = 9
        /// The warm cast behind the figure, clipped by the panel.
        static let castDiameter: CGFloat = 58
        /// Room around a panel's content inside its window for the drawn shadow (`Shadow` reaches
        /// 24 pt below in dark).
        static let shadowMargin: CGFloat = 24
    }

    /// Panel shadow, as CSS: `0 1 1 rgba(0,0,0,.05), 0 6 18 rgba(28,20,8,.12)` light;
    /// `0 1 1 rgba(0,0,0,.5), 0 8 24 rgba(0,0,0,.55)` dark. Drawn outside the shape only.
    struct Shadow {
        struct Layer {
            var color: UInt32
            var opacity: Double
            /// CSS blur; SwiftUI's and Core Animation's radius is half of it.
            var blur: CGFloat
            /// Downward offset.
            var y: CGFloat
        }

        var near: Layer
        var far: Layer

        static func panel(dark: Bool) -> Shadow {
            dark
                ? Shadow(near: Layer(color: 0x000000, opacity: 0.5, blur: 1, y: 1), far: Layer(color: 0x000000, opacity: 0.55, blur: 24, y: 8))
                : Shadow(near: Layer(color: 0x000000, opacity: 0.05, blur: 1, y: 1), far: Layer(color: 0x1C1408, opacity: 0.12, blur: 18, y: 6))
        }
    }

    /// The figure's sizes, by where it stands (DIRECTION.md section 4). Width; height is 11/12 of it.
    enum FigureSize {
        static let line: CGFloat = 14
        static let compact: CGFloat = 12
        static let popup: CGFloat = 16
        static let perch: CGFloat = 22
        static let onboarding: CGFloat = 64
        /// After the current alternative in the text: 0.6 of the caret's height, 12 to 14.
        static func inText(caretHeight: CGFloat) -> CGFloat { min(max((caretHeight * 0.6).rounded(), 12), 14) }
    }

    /// The uneven underline: one meaning everywhere, another version of this text exists. A sine
    /// of amplitude 0.45 and wavelength 10, stroke 1.25 round-capped, Carrot at 0.55, baseline + 2.
    /// T2 places it under writing marks; the look is here.
    enum Underline {
        static let amplitude: CGFloat = 0.45
        static let wavelength: CGFloat = 10
        static let stroke: CGFloat = 1.25
        static let opacity: Double = 0.55
        static let belowBaseline: CGFloat = 2
        /// Drawn left to right once, `ease-out`.
        static let draw: Double = 0.24
    }

    /// Ghost text and ghost fill: the host's color at this opacity.
    static func ghostOpacity(dark: Bool) -> Double { dark ? 0.50 : 0.45 }
}

extension Color {
    init(token: NSColor) { self.init(nsColor: TokenProbe.hides(token) ? .clear : token) }
}

extension Tokens {
    /// Hides one token's color in a render, so a test can compare the render with and without it
    /// and measure that token's contrast from pixels against what is actually behind it
    /// (`ContrastRenderTests`). Nil outside those tests.
    @MainActor static var hidden: NSColor?
}

enum TokenProbe {
    static func hides(_ token: NSColor) -> Bool {
        guard Thread.isMainThread else { return false }
        return MainActor.assumeIsolated { Tokens.hidden.map { $0 === token } ?? false }
    }
}

/// Motion tokens (DIRECTION.md section 3, "Motion"). Durations follow the `emil-design-eng`
/// frequency table; there is no user study behind them.
enum Motion {
    /// `ease-out`: every entrance, every exit, the step bar.
    static let easeOut = (0.23, 1.0, 0.32, 1.0)
    /// `ease-in-out`: the figure's posture and squash, the slip's height.
    static let easeInOut = (0.77, 0.0, 0.175, 1.0)

    /// Seconds.
    enum Duration {
        /// Ghost swap, tick move, highlight move, Tab insert: keyboard-driven, tens of times a day.
        static let swap: Double = 0
        /// Slip exit on Esc, pop-up exit.
        static let fade: Double = 0.10
        /// Typing dismisses a result.
        static let typed: Double = 0.08
        /// The slip's entrance: opacity, -2 pt, scale 0.97, from the corner at the caret.
        static let enter: Double = 0.16
        /// Pop-ups: the same, scale 0.96.
        static let pop: Double = 0.18
        /// A caption change inside a slip: the new words from opacity 0 and a 2 pt blur.
        static let swapIn: Double = 0.16
        /// The slip growing from 30 to 74 for the skill question; its second row enters at 0.22.
        static let grow: Double = 0.20
        static let growRow: Double = 0.22
        /// The step bar's fill to the next step.
        static let progress: Double = 0.42
        /// A result leaving after 5 s.
        static let toastExit: Double = 0.22
        /// The figure entering (opacity, 2 pt rise, scale 0.9) and leaving (4 pt rise, opacity).
        static let figureEnter: Double = 0.16
        static let figureLeave: Double = 0.16
        /// The eyes turning toward something.
        static let glance: Double = 0.14
        /// Done: squash 260, squint 420, glow pulse 600.
        static let squash: Double = 0.26
        static let squint: Double = 0.42
        static let glowPulse: Double = 0.60
        /// Offering breathes on a 4 s loop and blinks every 5 s.
        static let breath: Double = 4
        static let blinkEvery: Double = 5
        /// Needs you: two 600 ms bobs.
        static let bob: Double = 0.60
        /// Onboarding only.
        static let bow: Double = 0.52
        /// A filled field's wash; fields 40 ms apart.
        static let wash: Double = 0.40
        static let washStagger: Double = 0.04
        /// The fill slip moving to the next field.
        static let move: Double = 0.14
        /// Under Reduce Motion every entrance and exit becomes this fade.
        static let reduced: Double = 0.12
    }

    static func curve(_ c: (Double, Double, Double, Double), _ duration: Double) -> Animation {
        .timingCurve(c.0, c.1, c.2, c.3, duration: duration)
    }

    static func caCurve(_ c: (Double, Double, Double, Double)) -> CAMediaTimingFunction {
        CAMediaTimingFunction(controlPoints: Float(c.0), Float(c.1), Float(c.2), Float(c.3))
    }

    @MainActor static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// How a panel enters: Reduce Motion keeps a 0.12 s fade and drops the scale and the settle.
    struct Entrance: Equatable {
        var duration: Double
        /// Nil: opacity only.
        var scale: CGFloat?
        var settle: CGFloat

        static func panel(popup: Bool, reduce: Bool) -> Entrance {
            reduce
                ? Entrance(duration: Duration.reduced, scale: nil, settle: 0)
                : Entrance(duration: popup ? Duration.pop : Duration.enter, scale: popup ? 0.96 : 0.97, settle: 2)
        }
    }

    /// An exit: every exit is opacity; under Reduce Motion every one that fades is 0.12 s, and one
    /// that is at once stays at once.
    static func exit(_ duration: Double, reduce: Bool) -> Double { reduce && duration > 0 ? Duration.reduced : duration }
}
