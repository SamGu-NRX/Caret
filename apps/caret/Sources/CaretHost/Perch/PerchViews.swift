import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

extension Perch.Mood {
    /// The figure state that draws this mood. Waiting is the noticed pose: eyes open on the
    /// window, no breath, nothing asked of the user beyond the row's Continue.
    var figure: FigureState {
        switch self {
        case .working: return .working
        case .waiting: return .noticed
        case .needsYou: return .needsYou
        case .done: return .done
        case .error: return .error
        }
    }
}

/// What the perch view draws. The controller owns it; the view only renders it.
@MainActor
final class PerchModel: ObservableObject {
    /// The figure at the edge of the screen: about 32 pt (plan, strongest call 3).
    static let figureHeight: CGFloat = 32
    /// Room for the done squash (1.12 wide), the needs-you bob (about 5 pt at this size) and the
    /// count badge, and no more: the whole frame takes clicks.
    static let size = CGSize(width: 56, height: 48)

    @Published var presented = false
    @Published var mood: Perch.Mood = .working
    @Published var gaze: CGVector = .zero
    /// Rows in the Needs you section.
    @Published var needsYou = 0
    @Published var character: FigureCharacter = .pebble
    /// For screen readers: what the perch reports, in words.
    @Published var summary = ""
    /// Bumped every 5 s while the eyes are open on something: one blink each time.
    @Published var blinkTick = 0
    var animated = true
    var onTap: (() -> Void)?

    /// The count shows when it says something the figure does not: more than one item, or one
    /// item while the figure reports on something else.
    var showsCount: Bool {
        needsYou >= 2 || (needsYou == 1 && mood != .needsYou && mood != .waiting)
    }
}

/// The perch: the figure at 32 pt, its glance, and a count of what needs the user.
///
/// Motion (`IDENTITY.md`, shared): enters 180 ms `--ease-out` (opacity, scale 0.8 to 1, a 2 pt
/// rise); leaves 160 ms `--ease-out` (a 6 pt rise to nothing). Posture and gaze changes are the
/// figure's own 160 to 240 ms `--ease-in-out`. Reduce Motion turns entering and leaving into
/// 120 ms fades and stops the breath, the blink and the gestures (`FigureView`).
struct PerchView: View {
    @ObservedObject var model: PerchModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if model.presented {
                FigureView(
                    character: model.character, state: model.mood.figure,
                    height: PerchModel.figureHeight, animated: model.animated, gaze: model.gaze,
                    blinkTick: model.blinkTick
                )
                // Separates the flat figure from whatever is behind the screen's edge. A shadow,
                // not a glow (`IDENTITY.md`: no gradients, no glow).
                .shadow(color: .black.opacity(0.22), radius: 1.5, y: 1)
                .overlay(alignment: .topTrailing) {
                    if model.showsCount {
                        CountBadge(count: model.needsYou).offset(x: 10, y: -8)
                    }
                }
                .padding(.bottom, 2)
                .transition(transition)
            }
        }
        .frame(width: PerchModel.size.width, height: PerchModel.size.height, alignment: .bottom)
        .contentShape(Rectangle())
        .onTapGesture { model.onTap?() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Caret")
        .accessibilityValue(model.summary)
        .accessibilityHint("Shows Caret's activity")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.onTap?() }
    }

    private var transition: AnyTransition {
        if reduceMotion || !model.animated { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .scale(scale: 0.8, anchor: .bottom)).combined(with: .offset(y: 2)),
            removal: .opacity.combined(with: .offset(y: -6))
        )
    }
}

/// How many items need the user: a Carrot capsule with the eye color for the digit, the same
/// pairing as the figure's own body and eyes (4.6:1 in light, 7.7:1 in dark).
struct CountBadge: View {
    var count: Int

    var body: some View {
        Text(count > 9 ? "9+" : "\(count)")
            .font(.system(size: 10, weight: .semibold).monospacedDigit())
            .foregroundStyle(Color(token: Tokens.eye))
            .padding(.horizontal, 4)
            .frame(minWidth: 15, minHeight: 15)
            .background(Capsule().fill(Color(token: Tokens.carrot)))
            .fixedSize()
    }
}

// MARK: - The activity list

/// The activity list (plan section 3, "Reporting"): the ask field, then Needs you, In progress,
/// Done today. Each row is the end state as a sentence, its app and where the run is, and its
/// buttons. Opened from the perch or the menu bar. It takes keyboard focus only for the ask field,
/// and never activates Caret: the app the user was in stays in front.
struct ActivityListView: View {
    static let width: CGFloat = 320

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
    /// "What Caret knows" at the foot of the list: the memory window.
    var onKnows: () -> Void = {}
    var onAction: (String, RowAction) -> Void = { _, _ in }
    /// The ask field and what came of it (`AskSection`), under the header.
    var ask: AnyView? = nil
    /// The ask field shows an answer or a card: the empty list's sentence would read as part of it.
    var askActive = false

    static let knowsLink = "What Caret knows"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let ask {
                ask.padding(.top, 8).padding(.bottom, rows.isEmpty ? 4 : 0)
            }
            if rows.isEmpty, !askActive {
                Text("What Caret does or watches for you shows up here.")
                    .font(Tokens.Font.body)
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .padding(.leading, PopupView.figureSlot + 8)
                    .padding(.top, 2)
            }
            ForEach(ActivityRow.Section.allCases, id: \.self) { section in
                // Every row with a button is listed; only Done is capped (ActivityList.maxDone),
                // so no Continue or Undo is out of reach.
                let sectionRows = rows.filter { $0.section == section }
                if !sectionRows.isEmpty {
                    Text(section.title)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(token: Tokens.secondary))
                        .padding(.top, 10)
                        .padding(.bottom, 4)
                        .accessibilityAddTraits(.isHeader)
                    VStack(spacing: 2) {
                        ForEach(sectionRows) { row in
                            ActivityRowView(row: row, busy: busy.contains(row.id), now: now) { onAction(row.id, $0) }
                        }
                    }
                }
            }
            if more > 0 {
                // Under Done, aligned with the rows' text: the next five, in place.
                Button("and \(more) more", action: onMore)
                    .buttonStyle(MoreButtonStyle())
                    .padding(.leading, 10)
                    .padding(.top, 4)
                    .accessibilityLabel("Show \(min(more, ActivityList.maxDone)) more done today")
            }
            if incomplete {
                Text("Some older tasks didn't load.")
                    .font(Tokens.Font.hint)
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .padding(.leading, 10)
                    .padding(.top, 6)
            }
            // The way to what Caret knows and may do: quiet, under everything the list reports.
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.top, 10)
            Button(Self.knowsLink, action: onKnows)
                .buttonStyle(MoreButtonStyle())
                .padding(.leading, 10)
                .padding(.top, 6)
                .accessibilityHint("Opens what Caret remembers and what it may do")
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .frame(width: Self.width, alignment: .leading)
        .panelChrome(radius: 12)
    }


    private var header: some View {
        HStack(spacing: 8) {
            FigureView(character: character, state: mood?.figure ?? .noticed, facing: .right, height: 11, animated: animated)
                .frame(width: PopupView.figureSlot)
            Text(title).font(Tokens.Font.title).foregroundStyle(Color(token: Tokens.ink))
        }
        .accessibilityElement(children: .combine)
    }

    /// "1 needs you, 2 in progress"; "Nothing running" when the list is empty.
    var title: String {
        let needs = rows.filter { $0.section == .needsYou }.count
        let running = rows.filter { $0.section == .inProgress }.count
        var parts: [String] = []
        if needs > 0 { parts.append("\(needs) need\(needs == 1 ? "s" : "") you") }
        if running > 0 { parts.append("\(running) in progress") }
        if parts.isEmpty { return rows.isEmpty ? "Nothing running" : "All done" }
        return parts.joined(separator: ", ")
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
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(token: row.state == .undone ? Tokens.secondary : Tokens.ink))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(meta)
                    .font(Tokens.Font.hint)
                    // Secondary on the dark Carrot wash is 4.19:1, under AA for 11 pt; Ink at 72%
                    // keeps the step quieter than the sentence and reads above 6:1 in both themes.
                    .foregroundStyle(row.section == .needsYou ? Color(token: Tokens.ink).opacity(0.72) : Color(token: Tokens.secondary))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !row.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(row.actions, id: \.self) { action in
                        Button(action.label) { onAction(action) }
                            .buttonStyle(RowButtonStyle(primary: action == row.actions.first && action != .undo))
                            .disabled(busy)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .background(alignment: .leading) {
            if row.section == .needsYou {
                // Highlighted rows use the Carrot wash with a 2 pt Carrot edge (SURFACES.md 4).
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(token: Tokens.carrotWash))
                    Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2).padding(.vertical, 4)
                }
            }
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
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Motion.curve(Motion.easeOut, 0.12), value: configuration.isPressed)
            .fixedSize()
    }
}
