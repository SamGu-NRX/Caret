import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// MARK: - Environment

/// Off-screen renders (reference images) have no window and so no material: the view draws the
/// glass color and the shadow itself. On screen the panel window draws the material and the
/// shadow (`HostedPanel`), and the view draws only the ring, the highlight and the cast.
private struct OwnSurfaceKey: EnvironmentKey {
    static let defaultValue = false
}

/// Below macOS 26 the material is `NSVisualEffectView`, which carries no tint of its own: the
/// view lays the glass color over it.
private struct GlassTintKey: EnvironmentKey {
    static let defaultValue = false
}

/// Reduce Motion as the panel read it when it showed (`NSWorkspace`, once per show, DIRECTION.md
/// section 7). Views honour it as well as SwiftUI's own `accessibilityReduceMotion`.
private struct ReducesMotionKey: EnvironmentKey {
    static let defaultValue = false
}

/// The face Caret's sentences are set in (H5). Renders that compare the two set it.
private struct VoiceFaceKey: EnvironmentKey {
    static let defaultValue = Tokens.VoiceFace.newYork
}

extension EnvironmentValues {
    var drawsOwnSurface: Bool {
        get { self[OwnSurfaceKey.self] }
        set { self[OwnSurfaceKey.self] = newValue }
    }

    var drawsGlassTint: Bool {
        get { self[GlassTintKey.self] }
        set { self[GlassTintKey.self] = newValue }
    }

    var reducesMotion: Bool {
        get { self[ReducesMotionKey.self] }
        set { self[ReducesMotionKey.self] = newValue }
    }

    var voiceFace: Tokens.VoiceFace {
        get { self[VoiceFaceKey.self] }
        set { self[VoiceFaceKey.self] = newValue }
    }
}

// MARK: - Panel chrome

/// The glass panel's edge: a 1 pt ring, a 1 pt highlight along the top, and, where the window
/// draws no material, the glass color and the shadow (DIRECTION.md section 3).
struct PanelChrome: ViewModifier {
    var radius: CGFloat
    @Environment(\.drawsOwnSurface) private var ownSurface
    @Environment(\.drawsGlassTint) private var tint
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let shadow = Tokens.Shadow.panel(dark: scheme == .dark)
        content
            .background {
                if tint && !ownSurface {
                    shape.fill(Color(token: Tokens.glass))
                }
            }
            .clipShape(shape)
            .overlay(alignment: .top) {
                // The highlight: a 1 pt line just inside the ring along the top, clear of the
                // corners' curve.
                Rectangle().fill(Color(token: Tokens.glassHighlight)).frame(height: 1)
                    .padding(.horizontal, radius).padding(.top, 1)
            }
            .overlay { shape.strokeBorder(Color(token: Tokens.glassEdge), lineWidth: 1) }
            .background {
                if ownSurface {
                    shape.fill(Color(token: Tokens.glass))
                        .shadow(color: Self.color(shadow.near), radius: shadow.near.blur / 2, y: shadow.near.y)
                        .shadow(color: Self.color(shadow.far), radius: shadow.far.blur / 2, y: shadow.far.y)
                }
            }
    }
}

extension PanelChrome {
    static func color(_ layer: Tokens.Shadow.Layer) -> Color { Color(nsColor: Tokens.srgb(layer.color)).opacity(layer.opacity) }
}

extension View {
    func panelChrome(radius: CGFloat) -> some View { modifier(PanelChrome(radius: radius)) }
}

/// The figure's light on the glass: a warm radial behind it, clipped by the panel. Light mode
/// shows it faintly and dark mode clearly, as intended: a light reads better in the dark.
struct Cast: View {
    /// 1 at rest, 0.45 while the figure is away and its seat kept, 0 when the light is out.
    var strength: Double
    var diameter = Tokens.Shape.castDiameter

    var body: some View {
        RadialGradient(
            colors: [Color(token: Tokens.glow), Color(token: Tokens.glow).opacity(0)],
            center: .center, startRadius: 0, endRadius: diameter * 0.35
        )
        .frame(width: diameter, height: diameter)
        .opacity(strength)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Keys

/// A key hint: "Tab", "⌘Z", "Esc". 11 pt Medium in Ink 2 on the key fill, 17 tall, radius 4, a
/// 1 pt edge with a heavier bottom edge, so it reads as a key and not a tag.
struct Keycap: View {
    var text: String
    var compact = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Shape.keycapRadius, style: .continuous)
        Text(text)
            .font(compact ? .system(size: 10, weight: .medium) : Tokens.Font.key)
            .foregroundStyle(Color(token: Tokens.ink2))
            .padding(.horizontal, compact ? 4 : 5)
            .frame(height: compact ? 14 : Tokens.Shape.keycapHeight)
            .background(shape.fill(Color(token: Tokens.keyFill)))
            .overlay { shape.strokeBorder(Color(token: Tokens.keyEdge), lineWidth: 1) }
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color(token: Tokens.keyEdge)).frame(height: 0.5)
                    .padding(.horizontal, Tokens.Shape.keycapRadius)
                    .offset(y: -1)
            }
            .fixedSize()
            .accessibilityHidden(true)
    }
}

/// A keycap and what it does: "⌘Z Undo". The label is 12 pt Ink 2, 5 pt after the key.
struct HintView: View {
    var hint: Hint
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 4 : 5) {
            Keycap(text: hint.key, compact: compact)
            if let label = hint.label {
                Text(label).font(compact ? .system(size: 10.5) : Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
            }
        }
        .fixedSize()
    }
}

/// Monochrome line icons at 14 pt with a 1.5 pt stroke in Ink 2, drawn so they read at text size
/// (real app icons at 14 px are colored smears). A generic window for apps without one.
struct AppGlyph: View {
    var app: String
    var size: CGFloat = 14

    var body: some View {
        Canvas { context, canvas in
            let s = canvas.width / 14
            context.scaleBy(x: s, y: s)
            let stroke = StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
            let ink = GraphicsContext.Shading.color(Color(token: Tokens.ink2))
            for path in Self.paths(app) { context.stroke(path, with: ink, style: stroke) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    static func line(_ a: CGPoint, _ b: CGPoint) -> Path { Path { $0.move(to: a); $0.addLine(to: b) } }

    static func paths(_ app: String) -> [Path] {
        switch app {
        case "Calendar":
            return [
                Path(roundedRect: CGRect(x: 1.5, y: 2.5, width: 11, height: 10), cornerRadius: 2),
                line(CGPoint(x: 1.5, y: 6), CGPoint(x: 12.5, y: 6)),
                line(CGPoint(x: 4.5, y: 1), CGPoint(x: 4.5, y: 4)),
                line(CGPoint(x: 9.5, y: 1), CGPoint(x: 9.5, y: 4)),
            ]
        case "Mail":
            return [
                Path(roundedRect: CGRect(x: 1.5, y: 3, width: 11, height: 8.5), cornerRadius: 1.8),
                Path { $0.move(to: CGPoint(x: 2, y: 4)); $0.addLine(to: CGPoint(x: 7, y: 8)); $0.addLine(to: CGPoint(x: 12, y: 4)) },
            ]
        case "Messages":
            return [Path { p in
                p.move(to: CGPoint(x: 7, y: 1.8))
                p.addCurve(to: CGPoint(x: 12.5, y: 6.4), control1: CGPoint(x: 10.2, y: 1.8), control2: CGPoint(x: 12.5, y: 3.8))
                p.addCurve(to: CGPoint(x: 7, y: 11), control1: CGPoint(x: 12.5, y: 9), control2: CGPoint(x: 10.2, y: 11))
                p.addCurve(to: CGPoint(x: 5.3, y: 10.8), control1: CGPoint(x: 6.4, y: 11), control2: CGPoint(x: 5.8, y: 10.9))
                p.addLine(to: CGPoint(x: 2.5, y: 12))
                p.addLine(to: CGPoint(x: 3.2, y: 9.8))
                p.addCurve(to: CGPoint(x: 1.5, y: 6.4), control1: CGPoint(x: 2.1, y: 8.9), control2: CGPoint(x: 1.5, y: 7.8))
                p.addCurve(to: CGPoint(x: 7, y: 1.8), control1: CGPoint(x: 1.5, y: 3.8), control2: CGPoint(x: 3.8, y: 1.8))
                p.closeSubpath()
            }]
        case "Reminders":
            return [
                Path(ellipseIn: CGRect(x: 1.75, y: 2.5, width: 3, height: 3)),
                Path(ellipseIn: CGRect(x: 1.75, y: 8.5, width: 3, height: 3)),
                line(CGPoint(x: 7, y: 4), CGPoint(x: 12.5, y: 4)),
                line(CGPoint(x: 7, y: 10), CGPoint(x: 12.5, y: 10)),
            ]
        case "Safari":
            return [
                Path(ellipseIn: CGRect(x: 1.5, y: 1.5, width: 11, height: 11)),
                Path { p in
                    p.move(to: CGPoint(x: 9.5, y: 4.5)); p.addLine(to: CGPoint(x: 8, y: 8))
                    p.addLine(to: CGPoint(x: 4.5, y: 9.5)); p.addLine(to: CGPoint(x: 6, y: 6)); p.closeSubpath()
                },
            ]
        case "Notes":
            return [
                Path(roundedRect: CGRect(x: 2.5, y: 1.5, width: 9, height: 11), cornerRadius: 1.5),
                line(CGPoint(x: 4.75, y: 5), CGPoint(x: 9.25, y: 5)),
                line(CGPoint(x: 4.75, y: 8), CGPoint(x: 9.25, y: 8)),
            ]
        default:
            // A window: a frame, its title bar's rule and two lines of content.
            return [
                Path(roundedRect: CGRect(x: 1.5, y: 1.5, width: 11, height: 11), cornerRadius: 2),
                line(CGPoint(x: 4, y: 5), CGPoint(x: 10, y: 5)),
                line(CGPoint(x: 4, y: 8), CGPoint(x: 8, y: 8)),
            ]
        }
    }
}

// MARK: - The slip

/// The slip (DIRECTION.md section 5.3): the offer line, the working line with its step bar, the
/// result, the error, and the question that grows it from 30 to 74. It changes in place; every
/// state is this one view with different content, so the panel never re-enters between them.
///
/// Row: figure 14, gap 7, app glyph 14, gap 7, the sentence in Caret's voice, gap 12, keys. While
/// work runs the figure is away and its 14 pt seat stays empty, the cast at 45 percent; it
/// returns into the seat with Done.
///
/// Motion, each on its own value so a state change animates only what changed: the caption swaps
/// in from opacity 0 and a 2 pt blur (160 ms) without the seconds re-triggering it; the figure
/// leaves with a 4 pt rise and returns with a 2 pt settle (160 ms); the step bar fills in 420 ms;
/// the question row enters with a 4 pt rise (220 ms). Reduce Motion turns each into a 0.12 s fade
/// and keeps the bar's fill, which is information.
struct LineView: View {
    var content: LineContent
    var character: FigureCharacter
    /// 20 pt tall with 12 pt type, for a gap too tight for the standard slip (`LinePlacement`).
    var compact = false
    var animated = true
    /// Toward the words (right), or toward what the slip is about when that lies to its left.
    var figureFacing: FigureFacing = .right
    /// Where the figure looks instead, when what the slip is about is not beside it: the fill
    /// slip's figure looks down at its field.
    var figureGaze: CGVector?

    @Environment(\.voiceFace) private var face
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion

    private var moves: Bool { animated && !reduceMotion && !reducesMotion }
    private var figureSize: CGFloat { compact ? Tokens.FigureSize.compact : Tokens.FigureSize.line }
    /// Where the words start: the padding, the figure's seat and the gap.
    private var indent: CGFloat { Tokens.Shape.slipLeading + figureSize + Tokens.Shape.gap }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row
            if let question = content.question, !compact {
                Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1)
                QuestionRow(question: question)
                    .padding(.leading, indent)
                    .padding(.trailing, Tokens.Shape.slipTrailing)
                    .padding(.vertical, 7)
                    .frame(minHeight: Tokens.Shape.slipQuestionRow)
                    .transition(moves
                        ? .opacity.combined(with: .offset(y: -4)).animation(Motion.curve(Motion.easeOut, Motion.Duration.growRow))
                        : .opacity.animation(.linear(duration: Motion.Duration.reduced)))
            }
        }
        .frame(maxWidth: Tokens.Shape.slipMaxWidth, alignment: .leading)
        .fixedSize()
        .background(alignment: .topLeading) {
            Cast(strength: castStrength)
                .offset(x: Tokens.Shape.slipLeading + figureSize / 2 - Tokens.Shape.castDiameter / 2,
                        y: rowHeight / 2 - Tokens.Shape.castDiameter / 2)
                .animation(moves ? .linear(duration: 0.3) : nil, value: castStrength)
        }
        .overlay(alignment: .bottom) {
            if let progress = content.progress, !compact, content.question == nil {
                StepBar(progress: progress)
            }
        }
        .animation(moves ? Motion.curve(Motion.easeOut, Motion.Duration.grow) : nil, value: content.question != nil)
        .panelChrome(radius: compact ? Tokens.Shape.compactRadius : Tokens.Shape.slipRadius)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SlipSpeech.label(content) + (content.question.map { " " + SlipSpeech.sentences([$0.text, $0.detail ?? ""]) } ?? ""))
        .accessibilityValue(SlipSpeech.value(content) ?? "")
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var rowHeight: CGFloat { compact ? Tokens.Shape.compactHeight : Tokens.Shape.slipHeight }

    private var castStrength: Double {
        switch content.figure {
        case .absent: return 0.45
        case .error: return 0
        default: return 1
        }
    }

    private var row: some View {
        HStack(spacing: 0) {
            ZStack {
                if content.figure != .absent {
                    FigureView(character: character, state: content.figure, facing: figureFacing, size: figureSize, animated: animated, gaze: figureGaze)
                        .transition(figureTransition)
                }
            }
            .frame(width: figureSize, height: figureSize)
            .animation(moves ? Motion.curve(Motion.easeOut, Motion.Duration.figureEnter) : nil, value: content.figure == .absent)
            Spacer().frame(width: compact ? 6 : Tokens.Shape.gap)
            if let app = content.app {
                AppGlyph(app: app, size: compact ? 12 : 14)
                Spacer().frame(width: compact ? 6 : Tokens.Shape.gap)
            }
            caption
            if !content.hints.isEmpty {
                Spacer(minLength: compact ? 8 : Tokens.Shape.keysGap)
                HStack(spacing: compact ? 8 : Tokens.Shape.keysGap) {
                    ForEach(Array(content.hints.enumerated()), id: \.offset) { HintView(hint: $0.element, compact: compact) }
                }
            }
        }
        .padding(.leading, compact ? 5 : Tokens.Shape.slipLeading)
        .padding(.trailing, compact ? 5 : Tokens.Shape.slipTrailing)
        .frame(height: rowHeight)
        .animation(moves ? Motion.curve(Motion.easeOut, Motion.Duration.swapIn) : nil, value: SlipSpeech.withoutSeconds(content.text))
    }

    /// The figure leaves its seat with a 4 pt rise and returns with a 2 pt settle from 0.9.
    private var figureTransition: AnyTransition {
        guard moves else { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)).combined(with: .offset(y: 2)),
            removal: .opacity.combined(with: .offset(y: -4))
        )
    }

    /// The words. A new caption swaps in; the seconds after it count in place.
    private var caption: some View {
        let base = SlipSpeech.withoutSeconds(content.text)
        let seconds = String(content.text.dropFirst(base.count))
        return (leadText + bodyText(base) + bodyText(seconds))
            .lineLimit(1)
            .truncationMode(.tail)
            .id(SlipSpeech.caption(LineContent(figure: content.figure, lead: content.lead, text: base)))
            .transition(moves
                ? .asymmetric(insertion: .modifier(active: SwapIn(amount: 1), identity: SwapIn(amount: 0)), removal: .identity)
                : .identity)
    }

    private var voice: Font { compact ? .system(size: 12, weight: .medium, design: face.design) : Tokens.Font.voice(face) }

    private var leadText: Text {
        guard let lead = content.lead else { return Text("") }
        return Text(lead + " ")
            .font(compact ? .system(size: 12, weight: .semibold, design: face.design) : Tokens.Font.voiceLead(face))
            .foregroundColor(Color(token: Tokens.carrotText))
    }

    private func bodyText(_ text: String) -> Text {
        switch content.emphasis {
        case .endState, .plain:
            return Text(text).font(voice).foregroundColor(Color(token: Tokens.ink))
        case .secondary:
            // A source ("from Mail, Invoice 2041") is a label, not Caret speaking: SF, Ink 2.
            return Text(text).font(compact ? .system(size: 11) : Tokens.Font.chromeSmall).foregroundColor(Color(token: Tokens.ink2))
        }
    }
}

/// New words arrive from opacity 0 and a 2 pt blur.
private struct SwapIn: ViewModifier {
    var amount: Double
    func body(content: Content) -> some View {
        content.opacity(1 - amount).blur(radius: 2 * amount)
    }
}

/// 2 pt along the slip's bottom edge, inset 9 at each end, filling per step in 420 ms.
struct StepBar: View {
    var progress: Double

    var body: some View {
        Capsule()
            .fill(Color(token: Tokens.carrot))
            .frame(height: Tokens.Shape.barHeight)
            .scaleEffect(x: max(0, min(1, progress)), y: 1, anchor: .leading)
            .padding(.horizontal, Tokens.Shape.barInset)
            .animation(Motion.curve(Motion.easeOut, Motion.Duration.progress), value: progress)
            .accessibilityHidden(true)
    }
}

/// The keep or promote question under a result, or what its answer did: the helper's sentence in
/// Caret's voice, its detail in 12 pt Ink 2 under it, and the answers' keys at the right. Tab's
/// answer swaps the words at once: a key's result does not wait on motion.
struct QuestionRow: View {
    var question: LineContent.Question

    @Environment(\.voiceFace) private var face

    /// The words' room: the 520 pt slip less the indent (29), the trailing padding (10) and, with
    /// keys, the 16 pt gap and the keys themselves, measured with their own fonts.
    private var wrapWidth: CGFloat {
        let room = Tokens.Shape.slipMaxWidth - (Tokens.Shape.slipLeading + Tokens.FigureSize.line + Tokens.Shape.gap) - Tokens.Shape.slipTrailing
        guard !question.hints.isEmpty else { return room }
        func width(_ text: String, _ font: NSFont) -> CGFloat { ceil((text as NSString).size(withAttributes: [.font: font]).width) }
        let keys = question.hints.map { hint in
            width(hint.key, .systemFont(ofSize: 11, weight: .medium)) + 10 + (hint.label.map { 5 + width($0, .systemFont(ofSize: 12)) } ?? 0)
        }
        return room - 16 - keys.reduce(0, +) - Tokens.Shape.keysGap * CGFloat(keys.count - 1)
    }

    /// Wider than its room on one line. The panel is sized from its content's ideal size, which
    /// for text is one line; a column given a width wraps there and reports its full height.
    private var wraps: Bool {
        func width(_ text: String, _ font: NSFont) -> CGFloat { (text as NSString).size(withAttributes: [.font: font]).width }
        let voice = NSFont.systemFont(ofSize: 13.5, weight: .medium)
        let face = voice.fontDescriptor.withDesign(self.face.nsDesign).flatMap { NSFont(descriptor: $0, size: 13.5) } ?? voice
        return width(question.text, face) > wrapWidth
            || question.detail.map { width($0, .systemFont(ofSize: 12)) > wrapWidth } == true
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                // A skill's name runs to 80 characters (memory.ts): the question wraps rather than
                // cut it, and every word of it is shown.
                Text(question.text)
                    .font(Tokens.Font.voice(face))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = question.detail {
                    Text(detail)
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(width: wraps ? wrapWidth : nil, alignment: .leading)
            if !question.hints.isEmpty {
                Spacer(minLength: 16)
                HStack(spacing: Tokens.Shape.keysGap) {
                    ForEach(Array(question.hints.enumerated()), id: \.offset) { HintView(hint: $0.element) }
                }
            }
        }
    }
}
