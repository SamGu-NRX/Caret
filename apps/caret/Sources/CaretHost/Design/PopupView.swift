import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// A pop-up rendered from a `PopupSpec` (DIRECTION.md section 5.4): the same glass and placement
/// as the slip, at a larger size. The spec says what; this view owns layout, type and color.
///
/// Radius 12, padding 10 12 9, width 280 to 380. Header: figure 16, gap 8, the title in Caret's
/// voice at 15. Rows sit 24 pt in, under the title: a 62 pt key column in Ink 2 and the value in
/// Ink, 12.5/17. Footer: a hairline, then each action's key and label, Esc last. Keyboard-driven
/// changes (the highlight, a reveal) redraw at once: they happen tens of times a day.
struct PopupView: View {
    var spec: PopupSpec
    /// The highlighted choice row, from the arbiter's `OfferUI`.
    var highlight: Int?
    var character: FigureCharacter
    /// Overrides the spec's figure while work runs or after it ends.
    var figure: FigureState?
    var animated = true
    /// The Esc keycap that ends the bar. Off where Esc means something else (onboarding's Back).
    var showsEsc = true
    /// A fixed width, for a pop-up narrowed to fit between the app's fields; nil sizes it to its
    /// content within 280 to 380.
    var width: CGFloat?

    @Environment(\.voiceFace) private var face

    static let minWidth: CGFloat = Tokens.Shape.popupMinWidth
    static let figureSize: CGFloat = Tokens.FigureSize.popup
    /// The figure's slot in a header, which the rows indent past. The writing views read these.
    static let figureSlot: CGFloat = figureSize
    static let indent: CGFloat = figureSlot + 8

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(spec.blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 9)
        .padding(.horizontal, 12)
        .frame(minWidth: width ?? Self.minWidth, maxWidth: width ?? Tokens.Shape.popupMaxWidth, alignment: .leading)
        .fixedSize(horizontal: true, vertical: true)
        .background(alignment: .topLeading) {
            Cast(strength: figureState == .error ? 0 : 1, diameter: 64)
                .offset(x: 12 + Self.figureSize / 2 - 32, y: 10 + 10 - 32)
        }
        .panelChrome(radius: Tokens.Shape.popupRadius)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SlipSpeech.popup(spec, highlight: highlight))
    }

    @ViewBuilder
    private func blockView(_ block: PopupSpec.Block) -> some View {
        switch block.content {
        case .header(let header):
            HStack(alignment: .center, spacing: 8) {
                FigureView(character: character, state: figureState, facing: .right, size: Self.figureSize, animated: animated)
                    .frame(width: Self.figureSlot)
                Text(header.title.text)
                    .font(Tokens.Font.voiceLarge(face))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(2)
            }
            .frame(minHeight: 20)
        case .facts(let facts):
            rows(facts.rows.map { row in
                AnyView(HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if let label = row.label {
                        Text(label).foregroundStyle(Color(token: Tokens.ink2)).frame(width: Tokens.Shape.keyColumn, alignment: .leading)
                    }
                    Text(row.value.text).foregroundStyle(Color(token: row.secondary ? Tokens.ink2 : Tokens.ink))
                })
            })
        case .source(let source):
            rows([AnyView(Text("from \(source.value.text)").foregroundStyle(Color(token: Tokens.ink2)))])
        case .fields(let fields):
            rows(fields.rows.map { AnyView(FieldRow(row: $0)) }
                + (fields.more > 0 ? [AnyView(Text("and \(fields.more) more").foregroundStyle(Color(token: Tokens.ink2)))] : []))
        case .choices(let choices):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(choices.rows.enumerated()), id: \.offset) { index, row in
                    ChoiceRow(row: row, number: index + 1, highlighted: index == (highlight ?? choices.selected))
                }
            }
            .padding(.top, 6)
        case .diff(let diff):
            rows([AnyView(HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let label = diff.label { Text(label).foregroundStyle(Color(token: Tokens.ink2)) }
                Text(diff.before.text).strikethrough().foregroundStyle(Color(token: Tokens.ink2))
                Text("→").foregroundStyle(Color(token: Tokens.ink2))
                Text(diff.after.text).foregroundStyle(Color(token: Tokens.ink))
            })])
        case .steps(let steps):
            rows(steps.rows.map { AnyView(StepRow(row: $0)) })
        case .actions(let actions):
            Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1).padding(.top, 8).padding(.bottom, 8)
            HStack(spacing: Tokens.Shape.keysGap) {
                ForEach(actions.items, id: \.id) { action in
                    HintView(hint: Hint(key: Hint.key(action.key), label: action.label))
                }
                if showsEsc { HintView(hint: Hint(key: "Esc", label: nil)) }
            }
        }
    }

    /// Body rows: 12.5/17, aligned with the title.
    private func rows(_ rows: [AnyView]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(rows.enumerated()), id: \.offset) { $0.element }
        }
        .font(Tokens.Font.chrome)
        .padding(.leading, Self.indent)
        .padding(.top, 6)
    }

    private var figureState: FigureState {
        if let figure { return figure }
        switch spec.figure {
        case .offering: return .offering
        case .needsYou: return .needsYou
        }
    }
}

private struct FieldRow: View {
    var row: PopupSpec.Fields.Row

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(row.destination.text)
                .foregroundStyle(Color(token: Tokens.ink2))
                .frame(width: Tokens.Shape.keyColumn, alignment: .leading)
                .lineLimit(1)
            Text(row.value?.text ?? "")
                .foregroundStyle(Color(token: row.state == .kept ? Tokens.ink2 : Tokens.ink))
                .lineLimit(1)
            if let note {
                Spacer(minLength: 8)
                Text(note).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
            }
        }
    }

    /// Words, not icons or colors: success is not green and failure is not red.
    private var note: String? {
        switch row.state {
        case .ready: return nil
        case .kept: return "kept"
        case .unsure: return "unsure"
        case .done: return "filled"
        case .failed: return "not filled"
        }
    }
}

/// An option row: 24 tall. The chosen row has a 2 pt Carrot edge at its left and its words in Ink;
/// the others are Ink 2. No wash: Ink 2 on the Carrot wash measured 4.47:1 (T1).
private struct ChoiceRow: View {
    var row: PopupSpec.Choices.Row
    var number: Int
    var highlighted: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(row.label.text).foregroundStyle(Color(token: highlighted ? Tokens.ink : Tokens.ink2)).lineLimit(1)
            Spacer(minLength: 12)
            if let hint = row.hint {
                Text(hint.text).foregroundStyle(Color(token: Tokens.ink2)).lineLimit(1)
            }
            Keycap(text: "⌘\(number)")
        }
        .font(Tokens.Font.chrome)
        .padding(.leading, PopupView.indent)
        .frame(height: 24)
        .overlay(alignment: .leading) {
            if highlighted {
                Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2, height: 18)
                    .padding(.leading, PopupView.indent - 10)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }
}

/// A plan step: a 7 pt ring to do, a lit Carrot dot with the glow for the current step, a check in
/// Ink 2 when done.
private struct StepRow: View {
    var row: PopupSpec.Steps.Row

    var body: some View {
        HStack(spacing: 8) {
            mark.frame(width: 10, height: 10)
            Text(row.label).foregroundStyle(Color(token: row.state == .pending ? Tokens.ink2 : Tokens.ink))
        }
    }

    @ViewBuilder private var mark: some View {
        switch row.state {
        case .pending: Circle().strokeBorder(Color(token: Tokens.ink3), lineWidth: 1).frame(width: 7, height: 7)
        case .running:
            Circle().fill(Color(token: Tokens.carrot)).frame(width: 7, height: 7)
                .shadow(color: Color(token: Tokens.glow), radius: 3)
        case .done: Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
        case .failed: Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
        }
    }
}

// MARK: - Alternatives

/// H2's fallback for alternatives (DIRECTION.md section 6), off unless `CARET_ALTERNATIVES_LIST=list`:
/// after the second ↓ the candidates show as rows in the host's font under the line, the current
/// one in Ink with the 2 pt Carrot edge, the rest in Ink 2. No keycaps; ⌘1 to ⌘3 still work.
struct AlternativesListView: View {
    var candidates: [String]
    var current: Int
    /// The host field's font.
    var font: NSFont = .systemFont(ofSize: 13)

    static let rows = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(candidates.prefix(Self.rows).enumerated()), id: \.offset) { index, text in
                Text(text)
                    .font(Font(font))
                    .foregroundStyle(Color(token: index == current ? Tokens.ink : Tokens.ink2))
                    .lineLimit(1)
                    .padding(.leading, 10)
                    .frame(minHeight: 24, alignment: .leading)
                    .overlay(alignment: .leading) {
                        if index == current { Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2, height: 18) }
                    }
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 10)
        .frame(minWidth: 200, maxWidth: Tokens.Shape.popupMaxWidth, alignment: .leading)
        .fixedSize()
        .panelChrome(radius: Tokens.Shape.popupRadius)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(candidates.indices.contains(current) ? candidates[current] : "")
        .accessibilityValue("Alternative \(current + 1) of \(min(candidates.count, Self.rows))")
    }
}

/// What stands after the current alternative in the text (DIRECTION.md section 5.2): the figure,
/// eyes left toward the words, then a tick per candidate with the current one lit. Up to four.
/// Nothing here animates when ↓ moves: the text and the lit tick change at once.
struct AlternativesTag: View {
    var current: Int
    var count: Int
    var character: FigureCharacter
    var figureSize: CGFloat
    var animated = true

    static let maxTicks = 4

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            FigureView(character: character, state: .offering, facing: .left, size: figureSize, animated: animated)
            Ticks(current: current, count: count)
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Alternative \(current + 1) of \(min(count, Self.maxTicks))")
    }
}

/// 3 pt dots 4 apart in Ink 3; the current one 4 pt and Carrot.
struct Ticks: View {
    var current: Int
    var count: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<min(count, AlternativesTag.maxTicks), id: \.self) { i in
                Circle()
                    .fill(Color(token: i == current ? Tokens.carrot : Tokens.ink3))
                    .frame(width: i == current ? 4 : 3, height: i == current ? 4 : 3)
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// The uneven underline (`Tokens.Underline`): one meaning everywhere, another version of this
/// text exists. Draws once left to right in 240 ms `ease-out`; whole at once under Reduce Motion.
/// Never redraws on a swap, so its identity stays with the offer, not the candidate.
struct UnevenUnderline: View {
    var width: CGFloat
    var animated = true
    @State private var drawn: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion

    private var draws: Bool { animated && !reduceMotion && !reducesMotion }

    var body: some View {
        Wave()
            .trim(from: 0, to: draws ? drawn : 1)
            .stroke(Color(token: Tokens.carrot).opacity(Tokens.Underline.opacity), style: StrokeStyle(lineWidth: Tokens.Underline.stroke, lineCap: .round))
            .frame(width: width, height: 3)
            .onAppear {
                guard draws else { return }
                withAnimation(Motion.curve(Motion.easeOut, Tokens.Underline.draw)) { drawn = 1 }
            }
            .accessibilityHidden(true)
    }

    /// The sine, across the frame's whole width and no further.
    struct Wave: Shape {
        func path(in rect: CGRect) -> Path {
            Path { p in
                let mid = rect.midY
                let a = Tokens.Underline.amplitude, l = Tokens.Underline.wavelength
                p.move(to: CGPoint(x: rect.minX, y: mid))
                var x = rect.minX
                while x < rect.maxX {
                    x = min(x + 0.5, rect.maxX)
                    p.addLine(to: CGPoint(x: x, y: mid + a * sin((x - rect.minX) / l * 2 * .pi)))
                }
            }
        }
    }
}
