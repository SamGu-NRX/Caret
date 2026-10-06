import AppKit
import CaretHostCore
import SwiftUI

/// v41's tokens (design/v41 BUILD-FIRST.md "Tokens", DIRECTION.md 2), used by the page task panel and its crop only (brief
/// L1): every other surface keeps `Tokens`, so Sam compares one surface at a time. Each color is one `NSColor`, so
/// `ContrastRenderTests.measure` can hide it by identity and measure it from pixels. Where a value differs from v41, the
/// reason and its measurement are at the value.
enum CaretColor {
    static let ink = Tokens.dynamic(light: 0x1C1B19, dark: 0xF2EFEA)
    /// v41 2.1 moved v4's `#6B6864`/`#A8A49D` to `#64615C`/`#B5B1AA` from Chromium's bench. Measured here from this
    /// panel's pixels (L1RenderTests, the tint over the page with no blur, the worst case), v41's light value gave 4.16:1
    /// over a dark editor and 4.46:1 over a busy page; `#5B5853` clears 4.5 there. Dark is one step lighter for margin
    /// over a white page (4.56 at v41's value).
    static let ink2 = Tokens.dynamic(light: 0x5B5853, dark: 0xBAB6AF)
    /// The ring, the bracket, the dotted blank. v41 keeps v4's `#B3AFA8`/`#5E5A55`, which `Tokens.ink3` records at 2.0:1
    /// and 1.9:1 worst case; the dotted blank says "found nothing", so it needs 3:1 (WCAG 1.4.11). Today's `Tokens.ink3`
    /// measured 2.86:1 here (light over a busy page) and 3.07:1 (dark over a white page), and the blank's 2 pt dots, being
    /// antialiased, measure under their color's nominal ratio (2.83:1 at `#8E8A83` dark); these clear 3 on every host.
    static let ink3 = Tokens.dynamic(light: 0x736D67, dark: 0x9A968F)
    /// The writing rule and dot. v41's light `#D9641E` measured 2.96:1 as a mark over light glass on a dark editor
    /// (`Tokens.carrot`), and today's `#D35E19` 2.93:1 under v41's thinner 88% tint (L1RenderTests); `#CB5714` clears 3.
    static let carrot = Tokens.dynamic(light: 0xCB5714, dark: 0xF49A5B)
    /// The thread at rest: Ink 2 at 75%, over the page between the panel and the crop. Its own instance, reported apart.
    static let pencilThread = Tokens.dynamic(light: 0x64615C, dark: 0xB5B1AA)
    /// The thread while a value is written: Carrot, its own instance so the contrast table reports it apart. It runs over
    /// the page between the panel and the crop, so no tint stands behind it; it is a tie, not the progress (the rule is).
    static let carrotThread = Tokens.dynamic(light: 0xCB5714, dark: 0xF49A5B)
    /// v41 2.1: `#B24F12` failed 4.5:1 over a dark editor behind the glass (3.92).
    static let carrotText = Tokens.dynamic(light: 0x9E440E, dark: 0xF8A86D)
    static let graphite = Tokens.graphite
    /// Ink 2 as a mark, not text: a span's settled underline in the crop. Its own instance, so the contrast table
    /// measures it against 3:1 and Ink 2's text against 4.5:1.
    static let pencil = Tokens.dynamic(light: 0x64615C, dark: 0xB5B1AA)

    /// The pencil wash behind a span in a crop.
    static let band = Tokens.dynamic(light: 0x1C1B19, dark: 0xF2EFEA, alpha: 0.075, darkAlpha: 0.10)
    /// Withheld on purpose: 1 pt lines every 4 pt at 135°.
    static let hatch = Tokens.dynamic(light: 0x1C1B19, dark: 0xF2EFEA, alpha: 0.30, darkAlpha: 0.30)
    /// The row under the pointer.
    static let focusRow = Tokens.dynamic(light: 0x1C1B19, dark: 0xFFFFFF, alpha: 0.055, darkAlpha: 0.065)
    static let rule = Tokens.rule
    static let keyBG = Tokens.dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.035, darkAlpha: 0.06)
    static let keyEdge = Tokens.dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.15, darkAlpha: 0.17)

    // The glass under one light (2.3).
    /// The tint over the material: 88% light, 90% dark (`PageTaskLook.tint`).
    static let glassTint = Tokens.dynamic(light: 0xFAF9F6, dark: 0x22211F, alpha: 0.88, darkAlpha: 0.90)
    /// Reduce Transparency: the same color, opaque.
    static let panelOpaque = Tokens.dynamic(light: 0xFAF9F6, dark: 0x22211F)
    static let glassLift = Tokens.dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, alpha: 0.55, darkAlpha: 0.045)
    static let glassHi = Tokens.dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, alpha: 0.98, darkAlpha: 0.20)
    static let glassRim = Tokens.dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.12, darkAlpha: 0.11)
    /// Dark only: the 0.5 pt outer line that holds a dark panel's edge on a dark window.
    static let glassOuter = Tokens.dynamic(light: 0x000000, dark: 0x000000, alpha: 0, darkAlpha: 0.65)
    static let glassHiSide = Tokens.dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, alpha: 0.55, darkAlpha: 0.07)

    // A crop's paper: the user's document, opaque, in its own ink.
    static let paper = Tokens.dynamic(light: 0xFFFFFF, dark: 0x1E1E1E)
    static let paperInk = Tokens.dynamic(light: 0x1D1D1F, dark: 0xECECEC)
    static let paper2 = Tokens.dynamic(light: 0x6E6E73, dark: 0xA0A0A0)
    static let paperEdge = Tokens.dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.10, darkAlpha: 0.10)
}

/// v41's one curve family (DIRECTION 5.1): easeOutQuint for arrivals and draws, easeInOutQuint for things that move,
/// linear for pure fades. Durations come from `PageTaskLook.motion`; nil there is no animation here.
enum CaretMotion {
    static let outCurve = (0.22, 1.0, 0.36, 1.0)
    static let inOutCurve = (0.83, 0.0, 0.17, 1.0)

    static func out(_ ms: Double?) -> Animation? { ms.map { .timingCurve(outCurve.0, outCurve.1, outCurve.2, outCurve.3, duration: $0 / 1000) } }
    static func inOut(_ ms: Double?) -> Animation? { ms.map { .timingCurve(inOutCurve.0, inOutCurve.1, inOutCurve.2, inOutCurve.3, duration: $0 / 1000) } }
    static func fade(_ ms: Double?) -> Animation? { ms.map { .linear(duration: $0 / 1000) } }
}

/// v41's shapes and type for the page panel (DIRECTION 2.2 and 2.4).
enum LookShape {
    static let panelWidth: CGFloat = 340
    static let radius: CGFloat = 10
    static let rowHeight: CGFloat = 23
    /// Mark 14, label 96 (v41 has 84; the form's own field names here run longer, "Country of residence"), gap 8.
    static let markColumn: CGFloat = 14
    static let labelColumn: CGFloat = 96
    static let gap: CGFloat = 8
    static let figure: CGFloat = 13

    static let cropWidth = PageTaskLook.cropWidth
    static let cropGap = PageTaskLook.cropGap
    static let cropCaption: CGFloat = 25
    static let cropWindow: CGFloat = 118
    static let cropRadius: CGFloat = 10
    static let cropWindowRadius: CGFloat = 6
    static var cropHeight: CGFloat { cropCaption + cropWindow + 6 }

    /// Room in the window around the panel and crop for the cast shadow: it falls 14 pt down and blurs 15 pt beyond.
    static let shadowMargin: CGFloat = 32
}

enum LookFont {
    static let sentence = Font.system(size: 13, weight: .medium)
    static let row = Font.system(size: 12.5).monospacedDigit()
    static let meta = Font.system(size: 11.5)
    static let key = Font.system(size: 11, weight: .medium)
}
