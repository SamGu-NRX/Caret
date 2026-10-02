import AppKit
import SwiftUI

/// Caret's design tokens from `IDENTITY.md` ("Color", "Type") and the motion curves of the
/// prototype (`prototype/index.html`). One Carrot accent; everything else is the system's, so the
/// figure is the one foreign thing on screen.
///
/// Contrast, checked with the holistic-ux script: Carrot text on white 5.22:1, Secondary on white
/// 5.07:1, Secondary on the dark surface 5.42:1, Carrot on the dark surface 6.38:1, Eye on Carrot
/// 4.64:1 (light) and 7.71:1 (dark). Carrot on white is 3.63:1, enough for a mark, not for text.
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

    /// The figure, the underline, the chosen row's edge.
    static let carrot = dynamic(light: 0xD9641E, dark: 0xF49A5B)
    /// Words set in the accent ("Added", "Done").
    static let carrotText = dynamic(light: 0xB24F12, dark: 0xF49A5B)
    /// The highlighted row in a picker; a filled field after Tab.
    static let carrotWash = dynamic(light: 0xD9641E, dark: 0xF49A5B, alpha: 0.10, darkAlpha: 0.14)
    /// The figure's eyes, dark on the Carrot body in both themes.
    static let eye = srgb(0x1D1D1F)
    /// The error figure; the menu bar glyph at rest.
    static let graphite = dynamic(light: 0x8E8E93, dark: 0x98989D)
    static let ink = dynamic(light: 0x1D1D1F, dark: 0xF5F5F7)
    static let secondary = dynamic(light: 0x6E6E73, dark: 0xA1A1A6)
    static let border = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.08, darkAlpha: 0.10)
    /// Panel fill when no live material is available (off-screen renders). On screen the panel
    /// is the system popover material, which this approximates.
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x2C2C2E, alpha: 0.94, darkAlpha: 0.96)
    static let keycapBorder = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.12, darkAlpha: 0.16)

    enum Font {
        /// 13/16 semibold: a title or the offer sentence.
        static let title = SwiftUI.Font.system(size: 13, weight: .semibold)
        static let line = SwiftUI.Font.system(size: 13)
        /// 12/15: body rows.
        static let body = SwiftUI.Font.system(size: 12)
        /// 11/14: secondary text and key hints.
        static let hint = SwiftUI.Font.system(size: 11)
    }
}

extension Color {
    init(token: NSColor) { self.init(nsColor: token) }
}

/// Motion tokens. Durations are `IDENTITY.md`'s and `SURFACES.md`'s; curves are the prototype's.
enum Motion {
    /// `--ease-out`: entering and exiting.
    static let easeOut = (0.23, 1.0, 0.32, 1.0)
    /// `--ease-in-out`: posture changes on screen.
    static let easeInOut = (0.77, 0.0, 0.175, 1.0)
    /// `--ease-fall`: the seed falling over on error.
    static let easeFall = (0.32, 0.72, 0.0, 1.0)

    static func curve(_ c: (Double, Double, Double, Double), _ duration: Double) -> Animation {
        .timingCurve(c.0, c.1, c.2, c.3, duration: duration)
    }

    static func caCurve(_ c: (Double, Double, Double, Double)) -> CAMediaTimingFunction {
        CAMediaTimingFunction(controlPoints: Float(c.0), Float(c.1), Float(c.2), Float(c.3))
    }

    @MainActor static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}
