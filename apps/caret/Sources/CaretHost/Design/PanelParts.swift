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

/// A keycap and what it does: "Tab Add", "⌘Z Undo".
struct Hint: Equatable, Sendable {
    var key: String
    var label: String?

    static func key(_ key: PopupSpec.Action.Key) -> String {
        switch key {
        case .tab: return "Tab"
        case .cmd1: return "⌘1"
        case .cmd2: return "⌘2"
        case .cmd3: return "⌘3"
        case .down: return "↓"
        }
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

/// What an offer line shows: the figure, an optional app, an optional Carrot lead word, the text,
/// and trailing key hints.
struct LineContent: Equatable {
    var figure: FigureState
    var app: String?
    var lead: String?
    var text: String
    /// Secondary for a source line ("from Mail, Invoice 2041"); Ink semibold for an end state.
    var emphasis: Emphasis = .endState
    var hints: [Hint] = []
    /// The working line names the app in its caption, so it shows only the app's glyph, standing
    /// where the figure stood before it left.
    var appGlyphOnly = false

    enum Emphasis: Equatable {
        case endState, plain, secondary
    }
}

/// The offer line, the working line and the toast (`SURFACES.md` sections 3 and 6): 28 tall,
/// figure 11, app glyph 14, end state 13 semibold.
struct LineView: View {
    var content: LineContent
    var character: FigureCharacter
    /// 20 pt tall with 11 pt type, for a gap too tight for the standard line (`LinePlacement`).
    var compact = false
    var animated = true

    var body: some View {
        HStack(spacing: 0) {
            if content.figure != .absent {
                FigureView(character: character, state: content.figure, facing: .right, height: compact ? 9 : 11, animated: animated)
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
        .frame(maxWidth: 520, alignment: .leading)
        .fixedSize()
        .panelChrome(radius: compact ? 6 : 8)
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

/// The captions per character (`IDENTITY.md`, "Captions while working and when done"). No
/// exclamation marks, no "I think", no probabilities, no em dashes.
enum Captions {
    static func working(_ character: FigureCharacter, app: String) -> String {
        switch character {
        case .seed: return "Adding to \(app)"
        case .pebble: return "On it, \(app)"
        case .wren: return "Off to \(app)"
        }
    }

    /// The lead word (set in Carrot) and the rest.
    static func done(_ character: FigureCharacter, app: String) -> (lead: String, rest: String) {
        switch character {
        case .seed: return ("Added", "to \(app)")
        case .pebble: return ("Done,", "in \(app)")
        case .wren: return ("Back,", "added to \(app)")
        }
    }

    static func error(_ character: FigureCharacter, app: String) -> String {
        switch character {
        case .seed: return "\(app) didn't accept it. Open \(app) to add it."
        case .pebble, .wren: return "\(app) wouldn't take it. Open \(app) to add it."
        }
    }

    static let stopped = "Stopped"

    /// "1 field", "3 fields".
    static func fields(_ count: Int) -> String { count == 1 ? "1 field" : "\(count) fields" }

    /// The working line of a fill pop-up.
    static func filling(_ count: Int) -> String { "Filling \(fields(count))" }

    /// A fill run that stopped: what happened and what was left, without blame.
    static func fillStopped(filled: Int) -> String {
        filled == 0
            ? "The form changed, so nothing was filled."
            : "Filled \(fields(filled)). The form changed, so the rest was left as it is."
    }

    /// The run reached a send, submit, delete or pay step and left the press to the user.
    static func handoff(app: String) -> String { "Your turn in \(app)" }

    /// An undo that could not restore every field.
    static func undoPartial(notRestored: Int) -> String {
        notRestored == 1
            ? "1 field changed after the fill, so it was left as it is."
            : "\(notRestored) fields changed after the fill, so they were left as they are."
    }
}
