import CaretHostCore
import CaretScreenCore
import SwiftUI

/// A pop-up rendered from a `PopupSpec` (`SURFACES.md` section 4): the frame, then each block in
/// the order the spec lists it. The spec says what; this view owns layout, type and color.
///
/// Width 240 to 360, padding 10 by 12, radius 10. Body rows sit under the title, indented past the
/// figure, 6 apart. The action bar is generated from the spec's actions, with Esc always last.
/// Keyboard-driven changes (the highlight, a reveal) redraw at once with no animation: they happen
/// tens of times a day and motion would read as lag.
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
    /// content within 240 to 360.
    var width: CGFloat?

    static let minWidth: CGFloat = 240

    static let figureHeight: CGFloat = 11
    /// Every character sits in a 14 pt slot, so body rows line up under the title whichever one
    /// is chosen.
    static let figureSlot: CGFloat = 14
    static let indent: CGFloat = figureSlot + 8

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(spec.blocks.enumerated()), id: \.offset) { index, block in
                blockView(block, isFirst: index == 0)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .frame(minWidth: width ?? Self.minWidth, maxWidth: width ?? 360, alignment: .leading)
        .fixedSize(horizontal: true, vertical: true)
        .panelChrome(radius: 10)
    }

    @ViewBuilder
    private func blockView(_ block: PopupSpec.Block, isFirst: Bool) -> some View {
        switch block.content {
        case .header(let header):
            HStack(alignment: .center, spacing: 8) {
                FigureView(character: character, state: figureState, facing: .right, height: Self.figureHeight, animated: animated)
                    .frame(width: Self.figureSlot)
                Text(header.title.text)
                    .font(Tokens.Font.title)
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(2)
            }
            .frame(minHeight: 16)
        case .facts(let facts):
            body(rows: facts.rows.map { row in
                AnyView(HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if let label = row.label {
                        Text(label).foregroundStyle(Color(token: Tokens.secondary)).frame(width: 72, alignment: .leading)
                    }
                    Text(row.value.text).foregroundStyle(Color(token: row.secondary ? Tokens.secondary : Tokens.ink))
                })
            })
        case .source(let source):
            body(rows: [AnyView(
                Text("from \(source.value.text)").foregroundStyle(Color(token: Tokens.secondary))
            )])
        case .fields(let fields):
            body(rows: fields.rows.map { AnyView(FieldRow(row: $0)) }
                + (fields.more > 0 ? [AnyView(Text("and \(fields.more) more").foregroundStyle(Color(token: Tokens.secondary)))] : []))
        case .choices(let choices):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(choices.rows.enumerated()), id: \.offset) { index, row in
                    ChoiceRow(row: row, number: index + 1, highlighted: index == (highlight ?? choices.selected))
                }
            }
            .padding(.top, 6)
        case .diff(let diff):
            body(rows: [AnyView(HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let label = diff.label { Text(label).foregroundStyle(Color(token: Tokens.secondary)) }
                Text(diff.before.text).strikethrough().foregroundStyle(Color(token: Tokens.secondary))
                Text("→").foregroundStyle(Color(token: Tokens.secondary))
                Text(diff.after.text).foregroundStyle(Color(token: Tokens.ink))
            })])
        case .steps(let steps):
            body(rows: steps.rows.map { AnyView(StepRow(row: $0)) })
        case .actions(let actions):
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.vertical, 8)
            HStack(spacing: 12) {
                ForEach(actions.items, id: \.id) { action in
                    HintView(hint: Hint(key: Hint.key(action.key), label: action.label))
                }
                if showsEsc { HintView(hint: Hint(key: "Esc", label: nil)) }
            }
        }
    }

    /// Body rows: 12 pt, 6 apart, aligned with the title.
    private func body(rows: [AnyView]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { $0.element }
        }
        .font(Tokens.Font.body)
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
                .foregroundStyle(Color(token: Tokens.secondary))
                .frame(width: 72, alignment: .leading)
                .lineLimit(1)
            Text(row.value?.text ?? "")
                .foregroundStyle(Color(token: row.state == .kept ? Tokens.secondary : Tokens.ink))
                .lineLimit(1)
            if let note {
                Spacer(minLength: 8)
                Text(note).font(Tokens.Font.hint).foregroundStyle(Color(token: Tokens.secondary))
            }
        }
    }

    /// Words, not icons or colors: success is not green and failure is not red (`IDENTITY.md`).
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

/// A choice row: 24 tall, label Ink 12, hint Secondary 12 right-aligned before the keycap. The
/// highlighted row has the Carrot wash and a 2 pt Carrot left edge, never a filled block.
private struct ChoiceRow: View {
    var row: PopupSpec.Choices.Row
    var number: Int
    var highlighted: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(row.label.text).foregroundStyle(Color(token: Tokens.ink)).lineLimit(1)
            Spacer(minLength: 12)
            if let hint = row.hint {
                Text(hint.text).foregroundStyle(Color(token: Tokens.secondary)).lineLimit(1)
            }
            Keycap(text: "⌘\(number)")
        }
        .font(Tokens.Font.body)
        .padding(.leading, PopupView.indent)
        .padding(.trailing, 0)
        .frame(height: 24)
        // The highlight runs to the panel's edges: the 12 pt padding is bled back out.
        .padding(.horizontal, 12)
        .background {
            if highlighted {
                ZStack(alignment: .leading) {
                    Color(token: Tokens.carrotWash)
                    Color(token: Tokens.carrot).frame(width: 2)
                }
            }
        }
        .padding(.horizontal, -12)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }
}

private struct StepRow: View {
    var row: PopupSpec.Steps.Row

    var body: some View {
        HStack(spacing: 8) {
            mark.frame(width: 10, height: 10)
            Text(row.label).foregroundStyle(Color(token: row.state == .pending ? Tokens.secondary : Tokens.ink))
        }
    }

    @ViewBuilder private var mark: some View {
        switch row.state {
        case .pending: Circle().strokeBorder(Color(token: Tokens.secondary), lineWidth: 1)
        case .running: Circle().fill(Color(token: Tokens.carrot)).frame(width: 6, height: 6)
        case .done: Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.secondary))
        case .failed: Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.secondary))
        }
    }
}

// MARK: - Alternatives

/// The alternatives list under the caret while they are open: up to three rows numbered for
/// Command-1 to 3, the current one highlighted. A fourth and later candidate is reached with the
/// arrows and counted below the rows.
struct AlternativesListView: View {
    var candidates: [String]
    var current: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(candidates.prefix(3).enumerated()), id: \.offset) { index, text in
                ChoiceRow(
                    row: PopupSpec.Choices.Row(label: PopupSpec.Value(text, ref: .memory(id: "candidate"))),
                    number: index + 1,
                    highlighted: index == current
                )
            }
            if candidates.count > 3 {
                Text(current >= 3 ? "\(current + 1) of \(candidates.count)" : "and \(candidates.count - 3) more, ↓")
                    .font(Tokens.Font.hint)
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .padding(.leading, PopupView.indent)
                    .frame(height: 20)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 12)
        .frame(minWidth: 200, maxWidth: 360, alignment: .leading)
        .fixedSize()
        .panelChrome(radius: 8)
    }
}

/// The count and figure after the ghost text while alternatives are open: "◆ 2 of 4", 11 pt
/// Secondary, figure in Offering facing left toward the text.
struct AlternativesTag: View {
    var current: Int
    var count: Int
    var character: FigureCharacter
    var figureHeight: CGFloat
    var animated = true

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 4) {
            FigureView(character: character, state: .offering, facing: .left, height: figureHeight, animated: animated)
            Text("\(current + 1) of \(count)")
                .font(Tokens.Font.hint)
                .foregroundStyle(Color(token: Tokens.secondary))
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Alternative \(current + 1) of \(count)")
    }
}

/// The uneven underline: a sine of amplitude 0.6 and wavelength 7, stroke 1.5, round caps, Carrot
/// at 0.65. Draws once left to right in 240 ms `--ease-out`; whole at once under Reduce Motion.
/// Never redraws on a swap, so its identity stays with the offer, not the candidate.
struct UnevenUnderline: View {
    var width: CGFloat
    var animated = true
    @State private var drawn: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Wave()
            .trim(from: 0, to: animated && !reduceMotion ? drawn : 1)
            .stroke(Color(token: Tokens.carrot).opacity(0.65), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: width, height: 3)
            .onAppear {
                guard animated, !reduceMotion else { return }
                withAnimation(Motion.curve(Motion.easeOut, 0.24)) { drawn = 1 }
            }
            .accessibilityHidden(true)
    }

    struct Wave: Shape {
        func path(in rect: CGRect) -> Path {
            Path { p in
                let mid = rect.midY
                p.move(to: CGPoint(x: rect.minX, y: mid))
                var x = rect.minX
                while x <= rect.maxX {
                    p.addLine(to: CGPoint(x: x, y: mid + 0.6 * sin((x - rect.minX) / 7 * 2 * .pi)))
                    x += 0.5
                }
            }
        }
    }
}
