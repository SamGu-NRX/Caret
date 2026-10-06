import CoreGraphics
import Foundation

/// L1: the decisions behind v41's page task panel (design/v41 DIRECTION.md 2.3, 3 and 5, BUILD-FIRST.md), as plain values
/// so each one is tested without a screen. The views in CaretHost/Design/Look read these and only draw.
///
/// The v41 look applies to the page task panel and its crop only; every other surface keeps today's tokens, so Sam
/// compares one thing at a time.
public enum PageTaskLook {
    // MARK: - The figure

    /// The mark beside the panel's title. Sam has not chosen (v41 DIRECTION 1); each option renders in the L1 gallery.
    public enum Figure: String, CaseIterable, Sendable {
        /// Today's character (`FigureSettings`), as on every other surface.
        case today
        /// v4's flat caret with eyes.
        case v4Caret
        /// No figure: the title starts at the panel's edge.
        case none
        /// v41's recommendation: a pen-weighted ‸, the copy editor's "insert here".
        case proofreader
    }

    /// The one line to change once Sam picks.
    public static let figure: Figure = .today

    // MARK: - Motion (v41 DIRECTION 5)

    /// What made a change: a key the user pressed (Tab, Esc, ⌘Z, ⌘2), the helper (a receipt, the ending, a reveal), or
    /// the pointer (hovering a row).
    public enum Cause: Equatable, Sendable {
        case key, helper, pointer

        public init(_ m: PageTaskMotion) {
            self = m == .none ? .key : .helper
        }
    }

    /// How the writing rule under a value (and under its span in the crop) shows.
    public enum Rule: Equatable, Sendable {
        /// Draws left to right over this many milliseconds, `out`.
        case draws(ms: Double)
        /// Shown whole at once.
        case whole
        /// Not drawn: under Reduce Motion the value going solid and the check fading in are the change.
        case none
    }

    /// The milliseconds each verb takes for one change; nil is at once.
    public struct Motion: Equatable, Sendable {
        public var rule: Rule
        /// The writing rule and its thread fade, the check fades in (`settle`, linear).
        public var settle: Double?
        /// The crop arrives (`appear`): opacity, plus a 2 pt rise and scale .98 from its anchor corner unless `rises` is false.
        public var appear: Double?
        public var rises: Bool
        /// A new source's drawing replaces the old (`swap`): opacity, plus a 2 pt blur unless `blurs` is false.
        public var swap: Double?
        public var blurs: Bool
        /// The crop's drawing moves to another span (`pan`, `inOut`).
        public var pan: Double?
        /// The hairline from the row to the crop draws (`draw`); nil appears whole.
        public var thread: Double?
        /// The rows of a panel's first show fade in this far apart, capped at the sixth; nil: together.
        public var stagger: Double?
    }

    /// v41 5.2's vocabulary for one change. Keys move nothing (5.4: "Keyboard-caused changes animate nothing"); Reduce
    /// Motion keeps opacity only and draws no rule.
    public static func motion(_ cause: Cause, reduceMotion: Bool) -> Motion {
        if cause == .key {
            return Motion(rule: reduceMotion ? .none : .whole, settle: nil, appear: nil, rises: false, swap: nil, blurs: false, pan: nil, thread: nil, stagger: nil)
        }
        if reduceMotion {
            return Motion(rule: .none, settle: 120, appear: 120, rises: false, swap: 120, blurs: false, pan: nil, thread: nil, stagger: nil)
        }
        return Motion(rule: .draws(ms: 320), settle: 120, appear: 160, rises: true, swap: 140, blurs: true, pan: 200, thread: cause == .pointer ? 200 : 320, stagger: 30)
    }

    /// The first rows stagger; the sixth and later arrive with the sixth.
    public static let staggerCap = 5

    // MARK: - Material (v41 DIRECTION 2.3, BUILD-FIRST 2)

    public enum Material: Equatable, Sendable {
        /// macOS 26's system glass under the tint.
        case glass
        /// `NSVisualEffectView` (popover / HUD) under the tint, before macOS 26.
        case visualEffect
        /// No material: the tint at full strength. Reduce Transparency, and renders with no window behind them.
        case opaque
    }

    public static func material(reduceTransparency: Bool, glassAvailable: Bool) -> Material {
        if reduceTransparency { return .opaque }
        return glassAvailable ? .glass : .visualEffect
    }

    /// The tint over the material: 88% light, 90% dark, measured in v41 2.3 (Chromium's backdrop-filter; rerun against
    /// this panel in L1's contrast table); 100% when the material is off.
    public static func tint(dark: Bool, material: Material) -> Double {
        material == .opaque ? 1 : (dark ? 0.90 : 0.88)
    }

    // MARK: - The crop (v41 DIRECTION 3)

    /// Where the crop stands beside the panel (3.3).
    public enum CropSide: String, Equatable, Sendable {
        /// To the panel's right.
        case trailing
        /// To its left.
        case leading
        /// Over the panel's rows, aligned to its top; no thread (the band alone ties it).
        case overlay
    }

    public static let cropWidth: CGFloat = 240
    public static let cropGap: CGFloat = 22
    /// Keep this far inside the screen's edge.
    static let screenInset: CGFloat = 8

    /// To the right when it fits on screen; else to the left when it fits there and covers none of the field being
    /// filled; else over the panel. `panel`, `screen` and `field` are in one top-left space.
    public static func cropSide(panel: CGRect, screen: CGRect, field: CGRect?) -> CropSide {
        let room = cropGap + cropWidth
        if panel.maxX + room <= screen.maxX - screenInset { return .trailing }
        let leading = CGRect(x: panel.minX - room, y: panel.minY, width: room, height: panel.height)
        if leading.minX >= screen.minX + screenInset, !(field.map { leading.intersects($0) } ?? false) { return .leading }
        return .overlay
    }

    /// What the crop shows now, by the row's goal step: the row being written while a group runs (and nothing once it
    /// ends: "it follows the row being written and closes at Filled"); otherwise the row VoiceOver is on, else the one
    /// under the pointer. A row with nothing to show (no excerpt, not a blank) shows none.
    public static func cropStep(running: Bool, writing: Int?, voiceOver: Int?, pointer: Int?, shows: (Int) -> Bool) -> Int? {
        let wanted = running ? writing : (voiceOver ?? pointer)
        return wanted.flatMap { shows($0) ? $0 : nil }
    }

    /// The window's pan onto a drawing taller than it (3.2, BUILD-FIRST "Pan rule"): the span's line 42% down, snapped
    /// to the nearest line top at or above that, clamped to the drawing, and never mid-line. `lineTops` are in drawing
    /// space, ascending; a caller whose lines sit below a padding passes their tops less the padding.
    public static func pan(lineTops: [CGFloat], spanLine: Int, drawingHeight: CGFloat, window: CGFloat) -> CGFloat {
        guard drawingHeight > window, lineTops.indices.contains(spanLine) else { return 0 }
        let target = lineTops[spanLine] - window * 0.42
        let snapped = lineTops.last { $0 <= target } ?? 0
        let clamped = min(max(0, snapped), drawingHeight - window)
        // Clamped at the drawing's end, it snaps again, so no line is cut through at the top edge, unless that would push
        // the span's own line past the window's bottom: the span shows whole first.
        let again = lineTops.last { $0 <= clamped } ?? 0
        let spanBottom = spanLine + 1 < lineTops.count ? lineTops[spanLine + 1] : drawingHeight
        return spanBottom - again <= window ? again : clamped
    }
}
