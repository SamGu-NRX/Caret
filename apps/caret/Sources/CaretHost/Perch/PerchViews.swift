import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

extension Perch.Mood {
    /// The figure state that draws this mood on the window it works in.
    var figure: FigureState {
        switch self {
        case .working: return .noticed
        case .waiting: return .noticed
        case .needsYou: return .needsYou
        case .done: return .done
        case .error: return .error
        }
    }

    /// Where its eyes go on the perch: down at the window it fills while working or paused, out at
    /// the user when it needs them, Done and the error face forward.
    var gaze: CGVector? {
        switch self {
        case .working, .waiting: return CGVector(dx: -0.2, dy: 0.9)
        case .needsYou, .done, .error: return nil
        }
    }
}

/// What the perched figure draws. The controller owns it; the view only renders it.
@MainActor
final class PerchModel: ObservableObject {
    static let figureWidth: CGFloat = Rim.perchWidth
    /// The pebble's height at that width (viewBox 12 by 11); the other characters are within a point.
    static let figureHeight: CGFloat = Rim.perchWidth * 11 / 12
    /// Room for the done squash (1.12 wide) and the needs-you bob, and no more: the frame takes clicks.
    static let size = CGSize(width: 30, height: 28)

    @Published var presented = false
    @Published var mood: Perch.Mood = .working
    @Published var character: FigureCharacter = .pebble
    /// For screen readers: what the perch reports, in words.
    @Published var summary = ""
    var animated = true
    var onTap: (() -> Void)?
}

/// The figure perched on the window Caret works in (DIRECTION.md 5.7): 22 pt, straddling the
/// window's top edge 18 pt from its right, eyes down at what it fills; it faces you and bobs twice
/// when it needs you. Clicking it opens the desk.
///
/// Motion: it arrives with the figure's entrance (160 ms ease-out, opacity, a 2 pt settle, scale
/// 0.9) and hops off with a 4 pt rise to nothing (160 ms). At rest it blinks at irregular
/// intervals, as every figure does (`FigureIdle`). Reduce Motion keeps 120 ms fades and stops the
/// bob and the blinks (`FigureView`).
struct PerchView: View {
    @ObservedObject var model: PerchModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if model.presented {
                FigureView(
                    character: model.character, state: model.mood.figure, size: PerchModel.figureWidth,
                    animated: model.animated, gaze: model.mood.gaze
                )
                .transition(transition)
            }
        }
        .frame(width: PerchModel.size.width, height: PerchModel.size.height, alignment: .bottom)
        .contentShape(Rectangle())
        .onTapGesture { model.onTap?() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Caret")
        .accessibilityValue(model.summary)
        .accessibilityHint("Opens Caret's desk")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.onTap?() }
    }

    private var transition: AnyTransition {
        if reduceMotion || !model.animated { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.9, anchor: .bottom)).combined(with: .offset(y: 2)),
            removal: .opacity.combined(with: .offset(y: -4))
        )
    }
}

/// What the rim draws.
@MainActor
final class RimModel: ObservableObject {
    @Published var shown = false
    /// After a stop or a failure: the ring turns Graphite, then fades.
    @Published var graphite = false
    var animated = true
}

/// The warm rim around the window Caret works in: a 1.5 pt Carrot ring one point outside the
/// window's corners, and a 16 pt bloom of Glow beyond it. It appears over 220 ms; on a stop the ring
/// turns Graphite over 220 ms and fades out after 900 ms (the controller times the fade). The panel
/// holding it never takes a click.
struct RimView: View {
    @ObservedObject var model: RimModel
    /// The window's corner radius plus one. Assumed: windows have no API for their radius; 10 before
    /// macOS 26, 16 on it, read off standard document windows by eye.
    var radius: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius + 1, style: .continuous)
        let ring = Color(token: model.graphite ? Tokens.graphite : Tokens.carrot)
        shape
            .stroke(ring, lineWidth: Rim.ringWidth)
            .background {
                // The bloom: the ring's light, blurred outward and kept outside the window, so the
                // user's own window is never tinted. Glow, never a fill over the window.
                shape.stroke(Color(token: model.graphite ? .clear : Tokens.glow), lineWidth: 6)
                    .blur(radius: 6)
                    .mask {
                        Rectangle().padding(-Rim.bloom)
                            .overlay { shape.inset(by: Rim.ringWidth / 2).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
            }
            .padding(Rim.bloom - 1)
            .opacity(model.shown ? 1 : 0)
            .animation(model.animated ? .linear(duration: 0.22) : nil, value: model.graphite)
            .animation(model.animated ? Motion.curve(Motion.easeOut, 0.22) : nil, value: model.shown)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    static var windowRadius: CGFloat {
        if #available(macOS 26.0, *) { return 16 }
        return 10
    }
}

/// The caption at the window's bottom-left: what Caret is doing there, in its voice, and the step
/// ("2 of 3") in Chrome small. A 26 pt slip on the same glass.
struct RimCaption: View {
    var text: String
    var detail: String?

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.system(size: 12.5, weight: .medium, design: .serif))
                .foregroundStyle(Color(token: Tokens.ink))
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 9)
        .frame(height: Rim.captionHeight)
        .frame(maxWidth: 360)
        .fixedSize()
        .panelChrome(radius: 8)
        .accessibilityElement(children: .combine)
    }

    /// The caption's words for a task: what it does, then the step; "Ready for you" when it needs
    /// the user, with what is left to them.
    static func words(mood: Perch.Mood, row: ActivityRow?) -> (text: String, detail: String?) {
        switch mood {
        case .needsYou, .waiting:
            return ("Ready for you", row?.progress ?? row?.says)
        case .working, .done, .error:
            return (row?.says ?? "Working here", Rim.stepCount(row?.progress))
        }
    }
}

// MARK: - The desk

/// The desk (DIRECTION.md 5.6): ask and activity in one panel, 460 wide. The field at the top with
/// the figure reading along; under it what Caret made of the request; then what Caret does for you,
/// grouped as Needs you, Now and Done today; "What Caret knows" at the foot with a count of what
/// waits on you. Opened from the menu bar or the perch; it takes the keyboard only for the field,
/// and never brings Caret forward: the app the user was in stays the active app.
///
/// Rows are grouped rows on the glass, not cards: title 13 medium, a line of where it stands in
/// Ink 2, buttons at the right (Continue is the ink button; Undo, Show and Take over are key-styled),
/// and a 2 pt Carrot edge on a row that needs you. No washes.
struct ActivityListView: View {
    static let width: CGFloat = 460

    var rows: [ActivityRow]
    /// Done rows from today behind "and N more" (`ActivityList.page`).
    var more = 0
    /// The helper's last list was cut at its size cap, so older tasks may be missing.
    var incomplete = false
    var mood: Perch.Mood?
    var character: FigureCharacter
    /// Rows whose control is in flight: their buttons are disabled until the next record arrives.
    var busy: Set<String> = []
    var animated = true
    var now = Date()
    var onMore: () -> Void = {}
    /// "What Caret knows" at the foot: the memory window.
    var onKnows: () -> Void = {}
    var onAction: (String, RowAction) -> Void = { _, _ in }
    /// The ask field and what came of it (`AskSection`), at the top.
    var ask: AnyView? = nil
    /// The ask field shows an answer or a card: the empty desk's sentence would read as part of it.
    var askActive = false
    /// What the ask field holds, for the panel's spoken title (`ListHeader`).
    var askHeader: ListHeader.Ask = .none

    static let knowsLink = "What Caret knows"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let ask { ask }
            if rows.isEmpty, !askActive {
                Text(AskSection.emptyLine)
                    .font(.system(size: 13, weight: .medium, design: .serif))
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
            }
            ForEach(ActivityRow.Section.allCases, id: \.self) { section in
                // Every row with a button is listed; only Done is capped (ActivityList.maxDone),
                // so no Continue or Undo is out of reach.
                let sectionRows = rows.filter { $0.section == section }
                if !sectionRows.isEmpty {
                    Text(section.title)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .padding(.horizontal, 10)
                        .padding(.top, 12)
                        .padding(.bottom, 3)
                        .accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(sectionRows) { row in
                            ActivityRowView(row: row, busy: busy.contains(row.id), now: now) { onAction(row.id, $0) }
                        }
                    }
                }
            }
            if more > 0 {
                // Under Done, aligned with the rows' text: the next five, in place.
                Button("and \(more) more", action: onMore)
                    .buttonStyle(QuietButtonStyle())
                    .padding(.leading, 10)
                    .padding(.top, 2)
                    .accessibilityLabel("Show \(min(more, ActivityList.maxDone)) more done today")
            }
            if incomplete {
                Text("Some older tasks didn't load.")
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.leading, 10)
                    .padding(.top, 6)
            }
            Hairline().padding(.top, 10).padding(.horizontal, 2)
            HStack {
                Button(Self.knowsLink, action: onKnows)
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityHint("Opens what Caret remembers and what it may do")
                Spacer(minLength: 0)
                if needsYou > 0 {
                    Text("\(needsYou) need\(needsYou == 1 ? "s" : "") you")
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 5)
        }
        .padding(8)
        .frame(width: Self.width, alignment: .leading)
        .panelChrome(radius: Self.radius)
    }

    static let radius: CGFloat = 14

    private var needsYou: Int { rows.filter { $0.section == .needsYou }.count }

    /// "1 needs you, 2 in progress", "1 plan ready"; "Nothing running" when nothing is (`ListHeader`):
    /// the panel's name for the debug socket and VoiceOver's window title.
    var title: String {
        ListHeader.title(
            needsYou: needsYou,
            inProgress: rows.filter { $0.section == .inProgress }.count,
            hasRows: !rows.isEmpty, ask: askHeader
        )
    }
}

struct ActivityRowView: View {
    var row: ActivityRow
    var busy: Bool
    var now: Date
    var onAction: (RowAction) -> Void
    @Environment(\.timeZone) private var timeZone
    @Environment(\.locale) private var locale

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.says)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: row.state == .undone ? Tokens.ink2 : Tokens.ink))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(meta)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !row.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(row.actions, id: \.self) { action in
                        Button(action.label) { onAction(action) }
                            .buttonStyle(WindowButtonStyle(kind: action == .resume ? .ink : .key, small: true))
                            .disabled(busy)
                            .accessibilityLabel("\(action.label): \(row.says)")
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .background(alignment: .leading) {
            // A row that needs you: the 2 pt Carrot edge (DIRECTION.md 5.6: no wash).
            if row.section == .needsYou { NeedsYouEdge().padding(.vertical, 6) }
        }
        .accessibilityElement(children: .contain)
    }

    /// "Step 4 of 6 · Calendar"; finished rows add the time. Where the run is comes first: it is
    /// the one thing the row must not lose to truncation.
    private var meta: String {
        var parts: [String] = []
        if let progress = row.progress { parts.append(progress) }
        if let app = row.app { parts.append(app) }
        if row.section == .done {
            let f = DateFormatter()
            f.dateStyle = .none
            f.timeStyle = .short
            f.timeZone = timeZone
            f.locale = locale
            parts.append(f.string(from: Date(timeIntervalSince1970: Double(row.updatedAt) / 1000)))
        }
        return parts.isEmpty ? " " : parts.joined(separator: " · ")
    }
}

/// "and 3 more": a quiet text button in Secondary that turns Ink while pressed. It reads as the
/// end of the list, not as an action competing with the rows' buttons.
struct MoreButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Tokens.Font.hint)
            .foregroundStyle(Color(token: configuration.isPressed ? Tokens.ink : Tokens.secondary))
            .underline(configuration.isPressed)
            .frame(minHeight: 20)
            .contentShape(Rectangle())
            .fixedSize()
    }
}

/// A small bordered button: 11 pt, 22 tall. The first action of a row (Take over, Continue) is
/// set in Carrot text; Undo stays Ink. Pressing scales to 0.97 at once and springs back, so the
/// press reads even though the panel never takes focus.
struct RowButtonStyle: ButtonStyle {
    var primary: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A press shrinks the button a little; under Reduce Motion it does not, and the Carrot fill
    /// alone says the press landed.
    static func pressScale(pressed: Bool, reduceMotion: Bool) -> CGFloat {
        pressed && !reduceMotion ? 0.97 : 1
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: primary ? .semibold : .regular))
            .foregroundStyle(Color(token: primary ? Tokens.carrotText : Tokens.ink))
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(token: configuration.isPressed ? Tokens.carrotWash : Tokens.surface))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(Self.pressScale(pressed: configuration.isPressed, reduceMotion: reduceMotion))
            .animation(Motion.curve(Motion.easeOut, 0.12), value: configuration.isPressed)
            .fixedSize()
    }
}

// MARK: - Renders

/// Working in another window on a synthetic screen: a menu bar with Caret's glyph, the Tracker
/// window Caret fills, and in front of it either nothing (the rim, the perch and the caption, as
/// `Rim.layout` places them) or a Mail window covering it (H3: nothing is drawn on Tracker, and the
/// glyph is lit). Off screen only; nothing here reads the screen.
struct RimScene: View {
    var mood: Perch.Mood
    var covered = false
    var stopped = false
    var character: FigureCharacter = .pebble
    var caption = ("Fill the claim form from Invoice 2041", "Step 2 of 3")
    @Environment(\.colorScheme) private var scheme

    static let size = CGSize(width: 520, height: 330)
    static let menuBar: CGFloat = 24
    static let tracker = CGRect(x: 40, y: 70, width: 300, height: 190)
    static let mail = CGRect(x: 230, y: 120, width: 260, height: 170)

    var body: some View {
        let dark = scheme == .dark
        let visible = CGRect(x: 0, y: Self.menuBar, width: Self.size.width, height: Self.size.height - Self.menuBar)
        let layout = Rim.layout(window: Self.tracker, perchHeight: PerchModel.figureHeight, visible: visible)
        let rim = RimModel()
        rim.shown = !covered
        rim.graphite = stopped
        rim.animated = false
        let model = PerchModel()
        model.presented = !covered && !stopped
        model.animated = false
        model.mood = mood
        model.character = character
        let row = ActivityRow(id: "run-3", section: mood == .needsYou ? .needsYou : .inProgress, state: mood == .needsYou ? .needsYou : .running,
                              says: caption.0, app: "Tracker", progress: mood == .needsYou ? "Press Send" : caption.1, actions: [], updatedAt: 0)
        let words = RimCaption.words(mood: mood, row: row)
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x26282C : 0xD9DCE1)))
            MenuBarStrip(lit: !stopped, character: character, dark: dark)
            PerchScene.SceneWindow(title: "Tracker", dark: dark)
                .frame(width: Self.tracker.width, height: Self.tracker.height)
                .offset(x: Self.tracker.minX, y: Self.tracker.minY)
            if covered {
                PerchScene.SceneWindow(title: "Mail", dark: dark)
                    .frame(width: Self.mail.width, height: Self.mail.height)
                    .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
                    .offset(x: Self.mail.minX, y: Self.mail.minY)
            } else {
                RimView(model: rim, radius: 8)
                    .frame(width: layout.ring.width, height: layout.ring.height)
                    .offset(x: layout.ring.minX, y: layout.ring.minY)
                PerchView(model: model)
                    .offset(x: layout.perch.midX - PerchModel.size.width / 2, y: layout.perch.maxY - PerchModel.size.height)
                if !stopped {
                    RimCaption(text: words.text, detail: words.detail)
                        .offset(x: layout.caption.x, y: layout.caption.y)
                }
            }
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// The top of the screen: a menu bar with the clock and Caret's glyph, Carrot while lit.
    struct MenuBarStrip: View {
        var lit: Bool
        var character: FigureCharacter
        var dark: Bool

        var body: some View {
            HStack(spacing: 14) {
                Spacer()
                Image(nsImage: FigureGlyph.image(character, working: lit))
                    .renderingMode(lit ? .original : .template)
                    .foregroundStyle(Color(nsColor: dark ? .white : .black).opacity(0.85))
                Text("Tue 2:41 PM").font(.system(size: 12, weight: .medium)).foregroundStyle(Color(nsColor: dark ? .white : .black).opacity(0.85))
            }
            .padding(.horizontal, 12)
            .frame(width: RimScene.size.width, height: RimScene.menuBar)
            .background(Color(nsColor: dark ? Tokens.srgb(0x1C1D20) : Tokens.srgb(0xECEDEF)).opacity(0.95))
        }
    }
}

/// A window, roughly, for scenes: a title bar with three dots and a title, an empty body. Fixed
/// grays rather than Caret's tokens: it stands for someone else's app, and contrast probes measure
/// only Caret's own drawing.
enum PerchScene {
    struct SceneWindow: View {
        var title: String
        var dark: Bool

        var body: some View {
            let chrome = Color(nsColor: Tokens.srgb(dark ? 0x8C8E93 : 0x7A7C80))
            VStack(spacing: 0) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(chrome.opacity(0.45)).frame(width: 7, height: 7) }
                    Text(title).font(.system(size: 10, weight: .semibold)).foregroundStyle(chrome).padding(.leading, 6)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(height: 20)
                Rectangle().fill(chrome.opacity(0.25)).frame(height: 1)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach([0.8, 0.55, 0.65], id: \.self) { w in
                        RoundedRectangle(cornerRadius: 2).fill(chrome.opacity(0.22)).frame(height: 5).frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: w, y: 1, anchor: .leading)
                    }
                }
                .padding(10)
                Spacer(minLength: 0)
            }
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: Tokens.srgb(dark ? 0x2E2F33 : 0xFBFBFC))))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(chrome.opacity(0.3), lineWidth: 1))
        }
    }
}
