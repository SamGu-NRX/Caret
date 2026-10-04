import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// Whether a panel view draws its own surface, border and shadow. On screen the panel window
/// supplies the system material and shadow, and the view draws only the border. Off-screen renders
/// (reference images) have no window, so the view draws all three from the tokens.
private struct OwnSurfaceKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var drawsOwnSurface: Bool {
        get { self[OwnSurfaceKey.self] }
        set { self[OwnSurfaceKey.self] = newValue }
    }
}

/// Surface, 1 pt Border and Shadow (`IDENTITY.md`).
struct PanelChrome: ViewModifier {
    var radius: CGFloat
    @Environment(\.drawsOwnSurface) private var ownSurface
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                if ownSurface {
                    shape.fill(Color(token: Tokens.surface))
                        .shadow(color: .black.opacity(scheme == .dark ? 0.4 : 0.06), radius: 1, y: 1)
                        .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.12), radius: 12, y: 8)
                }
            }
            .overlay { shape.strokeBorder(Color(token: Tokens.border), lineWidth: 1) }
            .clipShape(shape)
    }
}

extension View {
    func panelChrome(radius: CGFloat) -> some View { modifier(PanelChrome(radius: radius)) }
}

/// A key hint: "Tab", "⌘2", "Esc". 11 pt Secondary, 16 tall, 1 pt border, radius 4.
struct Keycap: View {
    var text: String
    var compact = false

    var body: some View {
        Text(text)
            .font(.system(size: compact ? 10 : 11))
            .foregroundStyle(Color(token: Tokens.secondary))
            .padding(.horizontal, compact ? 4 : 5)
            .frame(height: compact ? 14 : 16)
            .overlay {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
            }
            .fixedSize()
    }
}

struct HintView: View {
    var hint: Hint
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 4 : 5) {
            Keycap(text: hint.key, compact: compact)
            if let label = hint.label {
                Text(label).font(.system(size: compact ? 10 : 11)).foregroundStyle(Color(token: Tokens.secondary))
            }
        }
        .fixedSize()
    }
}

/// Monochrome line icons at 14 pt with a 1.5 pt stroke, drawn so they read at text size (real app
/// icons at 14 px are colored smears, `SURFACES.md` section 3).
struct AppGlyph: View {
    var app: String

    var body: some View {
        Canvas { context, size in
            let s = size.width / 14
            context.scaleBy(x: s, y: s)
            let stroke = StrokeStyle(lineWidth: 1.5 / s * s, lineCap: .round, lineJoin: .round)
            let ink = GraphicsContext.Shading.color(Color(token: Tokens.secondary))
            for path in Self.paths(app) { context.stroke(path, with: ink, style: stroke) }
            if app == "Calendar" { context.fill(Path(ellipseIn: CGRect(x: 8.6, y: 8.1, width: 2, height: 2)), with: ink) }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }

    static func paths(_ app: String) -> [Path] {
        switch app {
        case "Calendar":
            // A rounded rect, two pegs and one dot.
            return [
                Path(roundedRect: CGRect(x: 1.75, y: 3, width: 10.5, height: 9.25), cornerRadius: 2),
                Path { $0.move(to: CGPoint(x: 4.75, y: 1.5)); $0.addLine(to: CGPoint(x: 4.75, y: 4.25)) },
                Path { $0.move(to: CGPoint(x: 9.25, y: 1.5)); $0.addLine(to: CGPoint(x: 9.25, y: 4.25)) },
            ]
        case "Mail":
            return [
                Path(roundedRect: CGRect(x: 1.5, y: 3.25, width: 11, height: 7.75), cornerRadius: 1.5),
                Path { $0.move(to: CGPoint(x: 2, y: 4)); $0.addLine(to: CGPoint(x: 7, y: 7.75)); $0.addLine(to: CGPoint(x: 12, y: 4)) },
            ]
        case "Messages":
            return [Path { p in
                p.addEllipse(in: CGRect(x: 1.5, y: 2.25, width: 11, height: 8.5))
                p.move(to: CGPoint(x: 3.5, y: 9.25))
                p.addLine(to: CGPoint(x: 2.5, y: 12))
                p.addLine(to: CGPoint(x: 5.75, y: 10.5))
            }]
        case "Reminders":
            return [
                Path(ellipseIn: CGRect(x: 1.75, y: 2.5, width: 3, height: 3)),
                Path(ellipseIn: CGRect(x: 1.75, y: 8.5, width: 3, height: 3)),
                Path { $0.move(to: CGPoint(x: 7, y: 4)); $0.addLine(to: CGPoint(x: 12.5, y: 4)) },
                Path { $0.move(to: CGPoint(x: 7, y: 10)); $0.addLine(to: CGPoint(x: 12.5, y: 10)) },
            ]
        case "Safari":
            return [
                Path(ellipseIn: CGRect(x: 1.5, y: 1.5, width: 11, height: 11)),
                Path { p in
                    p.move(to: CGPoint(x: 9.5, y: 4.5)); p.addLine(to: CGPoint(x: 8, y: 8))
                    p.addLine(to: CGPoint(x: 4.5, y: 9.5)); p.addLine(to: CGPoint(x: 6, y: 6)); p.closeSubpath()
                },
            ]
        default:
            // Notes, and any app without a drawn glyph: a page with two lines.
            return [
                Path(roundedRect: CGRect(x: 2.5, y: 1.5, width: 9, height: 11), cornerRadius: 1.5),
                Path { $0.move(to: CGPoint(x: 4.75, y: 5)); $0.addLine(to: CGPoint(x: 9.25, y: 5)) },
                Path { $0.move(to: CGPoint(x: 4.75, y: 8)); $0.addLine(to: CGPoint(x: 9.25, y: 8)) },
            ]
        }
    }
}

// MARK: - The line

/// The offer line, the working line and the toast (`SURFACES.md` sections 3 and 6): 28 tall,
/// figure 11, app glyph 14, end state 13 semibold.
struct LineView: View {
    var content: LineContent
    var character: FigureCharacter
    /// 20 pt tall with 11 pt type, for a gap too tight for the standard line (`LinePlacement`).
    var compact = false
    var animated = true
    /// Toward the words (right), or toward what the line is about when that lies to its left,
    /// as onboarding's try-it does with the sample source window.
    var figureFacing: FigureFacing = .right

    var body: some View {
        if let question = content.question, !compact {
            // A result with a question about it (B19): one panel, so ⌘Z, Tab and Esc read as one
            // place. The question sits under the line's words, past the figure's slot.
            VStack(alignment: .leading, spacing: 0) {
                row
                Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
                    .padding(.leading, PopupView.figureSlot + 16)
                QuestionRow(question: question, animated: animated)
                    .padding(.leading, PopupView.figureSlot + 16)
                    .padding(.trailing, 6)
                    .padding(.vertical, 7)
            }
            .frame(maxWidth: 520, alignment: .leading)
            .fixedSize()
            .panelChrome(radius: 8)
        } else {
            row
                .frame(maxWidth: 520, alignment: .leading)
                .fixedSize()
                .panelChrome(radius: compact ? 6 : 8)
        }
    }

    private var row: some View {
        HStack(spacing: 0) {
            if content.figure != .absent {
                FigureView(character: character, state: content.figure, facing: figureFacing, height: compact ? 9 : 11, animated: animated)
                    .frame(width: compact ? 12 : PopupView.figureSlot)
                Spacer().frame(width: compact ? 6 : 8)
            }
            if let app = content.app {
                AppGlyph(app: app)
                Spacer().frame(width: content.appGlyphOnly ? 8 : 6)
                if !content.appGlyphOnly {
                    Text(app).font(Tokens.Font.line).foregroundStyle(Color(token: Tokens.secondary))
                    Spacer().frame(width: 8)
                }
            }
            (leadText + bodyText)
                .lineLimit(1)
                .truncationMode(.tail)
            if !content.hints.isEmpty {
                Spacer(minLength: compact ? 8 : 12)
                HStack(spacing: compact ? 8 : 12) {
                    ForEach(Array(content.hints.enumerated()), id: \.offset) { HintView(hint: $0.element, compact: compact) }
                }
            }
        }
        .padding(.leading, compact ? 6 : 8)
        .padding(.trailing, compact ? 4 : 6)
        .frame(height: compact ? 20 : 28)
    }

    private var size: CGFloat { compact ? 11 : 13 }

    private var leadText: Text {
        guard let lead = content.lead else { return Text("") }
        return Text(lead + " ").font(.system(size: size, weight: .semibold)).foregroundColor(Color(token: Tokens.carrotText))
    }

    private var bodyText: Text {
        switch content.emphasis {
        case .endState: return Text(content.text).font(.system(size: size, weight: .semibold)).foregroundColor(Color(token: Tokens.ink))
        case .plain: return Text(content.text).font(.system(size: size)).foregroundColor(Color(token: Tokens.ink))
        case .secondary: return Text(content.text).font(.system(size: size)).foregroundColor(Color(token: Tokens.secondary))
        }
    }
}

/// The keep or promote question under a result line, or what its answer did: the helper's sentence
/// in Ink, its detail in Secondary under it, and the two answers' keys at the right.
///
/// Motion: the row arrives under a line already on screen, so it fades in and rises 3 pt over 160 ms
/// (`--ease-out`) rather than appear from nothing; Reduce Motion keeps the fade and drops the rise.
/// Tab's answer swaps the row's words at once: a key's result does not wait on motion.
struct QuestionRow: View {
    var question: LineContent.Question
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    /// The words' room when they must wrap: the 520 pt panel less the figure's indent and the
    /// trailing padding, and with keys, less the gap and two key hints ("Tab Keep  Esc No thanks").
    private var wrapWidth: CGFloat { question.hints.isEmpty ? 484 : 290 }

    /// Wider than its room on one line. The panel is sized from its content's ideal size, which
    /// for text is one line; a column given a width wraps there and reports its full height.
    private var wraps: Bool {
        func width(_ text: String, _ font: NSFont) -> CGFloat { (text as NSString).size(withAttributes: [.font: font]).width }
        return width(question.text, .systemFont(ofSize: 13, weight: .semibold)) > wrapWidth
            || question.detail.map { width($0, .systemFont(ofSize: 12)) > wrapWidth } == true
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            VStack(alignment: .leading, spacing: 1) {
                // A skill's name runs to 80 characters (memory.ts): the question wraps rather than
                // cut it, and the panel stays within its 520 pt.
                Text(question.text)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                    // 80 characters at the 290 pt the keys leave take three lines.
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = question.detail {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(Color(token: Tokens.secondary))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(width: wraps ? wrapWidth : nil, alignment: .leading)
            if !question.hints.isEmpty {
                Spacer(minLength: 16)
                HStack(spacing: 12) {
                    ForEach(Array(question.hints.enumerated()), id: \.offset) { HintView(hint: $0.element) }
                }
            }
        }
        .opacity(shown || !animated ? 1 : 0)
        .offset(y: shown || !animated || reduceMotion ? 0 : 3)
        .onAppear {
            guard animated, !shown else { return }
            withAnimation(Motion.curve(Motion.easeOut, 0.16)) { shown = true }
        }
        .accessibilityElement(children: .combine)
    }
}
