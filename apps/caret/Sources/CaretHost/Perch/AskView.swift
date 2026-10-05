import AppKit
import CaretHostCore
import SwiftUI

/// What the ask field draws, published for the view. `PerchController` copies `AskCaret`'s state
/// into it, so typing redraws the field inside SwiftUI rather than rebuilding the desk panel.
@MainActor
final class AskModel: ObservableObject {
    @Published var text = ""
    @Published var phase: AskCaret.Phase = .idle
    /// Bumped to move keyboard focus into the field.
    @Published var focusToken = 0
    /// The plan's noticed fact, with "Not right", while the card shows (M1).
    @Published var notRight: NotRightRow?
    var edit: (String) -> Void = { _ in }
    var submit: () -> Void = {}
    var run: () -> Void = {}
    var escape: () -> Void = {}
    var undo: () -> Void = {}
    var notRightAction: (DeskNotRight) -> Void = { _ in }
}

/// What the desk's "Not right" row asks for.
enum DeskNotRight: Equatable {
    case open, edit(String), save, forget, cancel
}

/// The desk's field (DIRECTION.md 5.6) and under it what Caret made of the request: "Planning", the
/// reason there is no plan, or the plan as a bordered block.
///
/// The figure sits in the field and reads along: eyes at you while it is empty, toward the end of
/// the words while there are some, down while Caret plans. Every change here follows a key the
/// user pressed or a step of a run they started, many times a day, so none of it animates
/// (`emil-design-eng`: keyboard-initiated changes never do); the eyes jump. The desk's own 180 ms
/// entrance is the only motion, and the current step's dot pulses while a plan runs.
struct AskSection: View {
    var text: String
    var phase: AskCaret.Phase
    var character: FigureCharacter
    var focusToken = 0
    /// Off screen only: draw the field focused.
    var showsFocus = false
    var animated = true
    var notRight: NotRightRow? = nil
    var onEdit: (String) -> Void = { _ in }
    var onSubmit: () -> Void = {}
    var onRun: () -> Void = {}
    var onEscape: () -> Void = {}
    var onUndo: () -> Void = {}
    var onNotRight: (DeskNotRight) -> Void = { _ in }

    static let fieldTitle = "Ask Caret"
    static let emptyLine = "Nothing running. Caret shows up where you type when it has something."

    /// The Return hint shows only while there is a request to send.
    static func showsHint(text: String, phase: AskCaret.Phase) -> Bool {
        phase == .idle && !text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// What VoiceOver says the field does now.
    private var fieldHint: String {
        switch phase {
        case .proposed: return "Tab runs the plan below. Escape puts it away."
        case .question(let q): return AskCopy.questionHint(q.ask.pick)
        case .running: return "A plan is running. Escape stops it."
        case .asking: return "Caret is planning what you asked."
        case .idle, .failed, .ended: return "Return plans it. Nothing runs until you press Tab."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DeskField(
                text: text, phase: phase, character: character, showsHint: Self.showsHint(text: text, phase: phase),
                focusToken: focusToken, showsFocus: showsFocus, onEdit: onEdit, onSubmit: onSubmit
            )
            .accessibilityHint(fieldHint)
            under
        }
    }

    @ViewBuilder private var under: some View {
        switch phase {
        case .idle:
            EmptyView()
        case .asking:
            status(AskCopy.planning, ink: false)
        case .failed(let sentence):
            status(sentence, ink: true)
        case .proposed(let card):
            AskCard(card: card, ending: nil, running: false, character: character, animated: animated, notRight: notRight,
                    onRun: onRun, onEscape: onEscape, onNotRight: onNotRight).padding(.top, 8)
        case .question(let q):
            AskQuestionCard(question: q, onAnswer: onRun, onEscape: onEscape).padding(.top, 8)
        case .running(let card):
            AskCard(card: card, ending: nil, running: true, character: character, animated: animated, onRun: onRun, onEscape: onEscape).padding(.top, 8)
        case .ended(let card, let line):
            AskCard(card: card, ending: line, running: false, character: character, animated: animated, onRun: onRun, onEscape: onEscape, onUndo: onUndo).padding(.top, 8)
        }
    }

    /// Planning, or why there is no plan: Caret speaking, in the voice.
    private func status(_ words: String, ink: Bool) -> some View {
        Text(words)
            .font(.system(size: 13, weight: .medium, design: .serif))
            .foregroundStyle(Color(token: ink ? Tokens.ink : Tokens.ink2))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, DeskField.textInset)
            .padding(.top, 10)
            .padding(.bottom, 2)
    }
}

/// Caret's own field: 38 tall, radius 9, the figure 16 inside it with its cast, a Carrot 1 pt
/// border and a 2.5 pt Carrot wash halo while it has focus (DIRECTION.md: the one field where the
/// focus ring is Caret's). A real `TextField` on screen; drawn off screen.
struct DeskField: View {
    var text: String
    var phase: AskCaret.Phase
    var character: FigureCharacter
    var showsHint: Bool
    var focusToken = 0
    var showsFocus = false
    var onEdit: (String) -> Void = { _ in }
    var onSubmit: () -> Void = {}

    @Environment(\.rendersOffscreen) private var offscreen
    @FocusState private var focused: Bool

    static let height: CGFloat = 38
    static let radius: CGFloat = 9
    static let font = Font.system(size: 13.5)
    /// Where text starts inside the field: 10 in, the figure, 9 after it.
    static let textInset: CGFloat = 10 + Tokens.FigureSize.popup + 9

    private var isFocused: Bool { offscreen ? showsFocus : focused }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        HStack(spacing: 9) {
            FigureView(character: character, state: figureState, facing: .right, size: Tokens.FigureSize.popup, animated: false, gaze: gaze)
                .background(Cast(strength: 1, diameter: 44))
                .accessibilityHidden(true)
            field
            if showsHint {
                Keycap(text: "\u{21A9}")
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 9)
        .frame(height: Self.height)
        .background(shape.fill(Color(token: Tokens.card)))
        .clipShape(shape)
        .overlay { shape.strokeBorder(Color(token: isFocused ? Tokens.carrot : Tokens.rule), lineWidth: 1) }
        .overlay {
            if isFocused {
                RoundedRectangle(cornerRadius: Self.radius + 2.5, style: .continuous)
                    .strokeBorder(Color(token: Tokens.carrotWash), lineWidth: 2.5)
                    .padding(-2.5)
            }
        }
    }

    @ViewBuilder
    private var field: some View {
        if offscreen {
            HStack(spacing: 0) {
                if text.isEmpty {
                    if showsFocus { caret }
                    Text(AskCopy.placeholder).foregroundStyle(Color(token: Tokens.ink2))
                } else {
                    Text(text).foregroundStyle(Color(token: Tokens.ink)).lineLimit(1)
                    if showsFocus { caret }
                }
                Spacer(minLength: 0)
            }
            .font(Self.font)
            .accessibilityHidden(true)
        } else {
            TextField(AskSection.fieldTitle, text: Binding(get: { text }, set: onEdit),
                      prompt: Text(AskCopy.placeholder).foregroundStyle(Color(token: Tokens.ink2)))
                .textFieldStyle(.plain)
                .labelsHidden()
                .font(Self.font)
                .foregroundStyle(Color(token: Tokens.ink))
                .focused($focused)
                .onSubmit(onSubmit)
                .accessibilityLabel(AskSection.fieldTitle)
                .onChange(of: focusToken) { _, _ in focused = true }
        }
    }

    private var caret: some View {
        Rectangle().fill(Color(token: Tokens.ink)).frame(width: 1, height: 16)
    }

    /// At you while empty (the larger eyes of Needs you, held still: `animated` is off), reading
    /// along otherwise, down while planning.
    private var figureState: FigureState {
        if case .idle = phase, text.isEmpty { return .needsYou }
        if case .failed = phase { return .still }
        return .noticed
    }

    /// Toward the end of the words: from a quarter right at the first letter to fully right past
    /// about 300 pt of text, so the eyes move as the line grows and stop where the field does.
    private var gaze: CGVector? {
        switch phase {
        case .asking, .running: return CGVector(dx: 0.15, dy: 0.9)
        case .idle where text.isEmpty: return CGVector(dx: 0, dy: 0.001)
        default:
            let width = (text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 13.5)]).width
            return CGVector(dx: 0.25 + 0.75 * min(1, width / 300), dy: 0.15)
        }
    }
}

/// The plan as a bordered block (hairline, radius 10): its title in Caret's voice, each step with a
/// mark for its state and the presses left to the user marked "You do this" in Carrot text, and
/// what Tab and Esc do; once it runs, each step's state and then the line that says how it ended.
struct AskCard: View {
    var card: AskCaret.Card
    var ending: WorkLine?
    var running: Bool
    var character: FigureCharacter
    var animated = true
    var notRight: NotRightRow? = nil
    /// The card's keys as named VoiceOver actions: Tab's run, Esc's stop or dismiss, and ⌘Z's undo.
    var onRun: () -> Void = {}
    var onEscape: () -> Void = {}
    var onUndo: () -> Void = {}
    var onNotRight: (DeskNotRight) -> Void = { _ in }

    var body: some View {
        Block {
            VStack(alignment: .leading, spacing: 0) {
                Text(card.title)
                    .font(Tokens.Font.voiceLarge(.newYork))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(card.steps.enumerated()), id: \.offset) { _, step in
                        AskStepRow(step: step, started: running || ending != nil, animated: animated)
                    }
                    if card.more > 0 {
                        Text("and \(card.more) more \(card.more == 1 ? "field" : "fields")")
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                            .padding(.leading, AskStepRow.markWidth + 8)
                    }
                }
                .padding(.top, 8)
                if let notRight {
                    DeskNotRightRow(row: notRight, send: onNotRight).padding(.top, 10)
                }
                Hairline().padding(.vertical, 9)
                footer
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 9)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Caret's plan")
        .modifier(CardActions(
            proposed: !running && ending == nil, running: running, undoable: ending?.content.hints.contains { $0.key == "⌘Z" } == true,
            action: card.action, onRun: onRun, onEscape: onEscape, onUndo: onUndo
        ))
    }

    @ViewBuilder private var footer: some View {
        if let ending {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                (Text(ending.content.lead.map { $0 + " " } ?? "").foregroundColor(Color(token: Tokens.carrotText)).fontWeight(.semibold)
                    + Text(ending.content.text).foregroundColor(Color(token: Tokens.ink)))
                    .font(.system(size: 13, weight: .medium, design: .serif))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // ⌘Z Undo on a run that wrote (q1 bug 8), as on a fill's toast.
                ForEach(ending.content.hints, id: \.key) { HintView(hint: $0) }
                HintView(hint: Hint(key: "Esc", label: "Close"))
            }
        } else if running {
            HStack(spacing: 12) {
                Text("Working in \(card.app)").font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
                    .frame(maxWidth: .infinity, alignment: .leading)
                HintView(hint: Hint(key: "Esc", label: "Stop"))
            }
        } else {
            HStack(spacing: 12) {
                HintView(hint: Hint(key: "Tab", label: card.action))
                HintView(hint: Hint(key: "Esc", label: "Dismiss"))
                Spacer(minLength: 0)
            }
        }
    }
}

/// "Not right" on a plan built from a noticed fact: the same row as under a slip, with buttons the
/// desk can take (it is key while open). Click "Not right" for the field.
struct DeskNotRightRow: View {
    var row: NotRightRow
    var send: (DeskNotRight) -> Void

    var body: some View {
        switch row.phase {
        case .shown:
            HStack(spacing: 10) {
                Text(row.sentence)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button("Not right") { send(.open) }.buttonStyle(QuietButtonStyle())
                    .accessibilityHint("Forget what Caret noticed, or say what's right")
            }
        case .correcting, .sending:
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if row.correctable {
                        EntryField(title: "What's right", text: row.text, placeholder: "What's right", autofocus: true, showsFocus: true,
                                   enabled: row.phase == .correcting, onChange: { send(.edit($0)) }, onSubmit: { send(.save) })
                    } else {
                        Text("Caret will forget this and stop using it.")
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Button("Cancel") { send(.cancel) }.buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    Button("Forget") { send(.forget) }.buttonStyle(WindowButtonStyle(kind: row.correctable ? .key : .ink, small: true))
                    if row.correctable {
                        Button(row.phase == .sending ? "Saving" : "Save") { send(.save) }.buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    }
                }
                .disabled(row.phase == .sending)
                if let problem = row.problem {
                    Text(problem).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink))
                }
            }
        case .answered(let sentence):
            Text(sentence).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink))
        }
    }
}

/// B29: an Ask's question in the desk, in the card's block: the helper's question in Caret's voice,
/// one row per choice, and the keys. The highlighted row has the popup's 2 pt Carrot edge and Ink
/// words; the others are Ink 2. A fields question marks each row with a box Space ticks. Arrows and
/// Space redraw at once with no motion: each follows a key the user is watching (`emil-design-eng`).
struct AskQuestionCard: View {
    var question: AskCaret.Question
    var onAnswer: () -> Void = {}
    var onEscape: () -> Void = {}

    var body: some View {
        Block {
            VStack(alignment: .leading, spacing: 0) {
                Text(question.ask.text)
                    .font(Tokens.Font.voiceLarge(.newYork))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(question.ask.options.enumerated()), id: \.element.id) { index, option in
                        AskChoiceRow(
                            option: option, highlighted: index == question.highlight,
                            selected: question.ask.pick == .many ? question.selected.contains(option.id) : nil
                        )
                    }
                }
                .padding(.top, 6)
                Hairline().padding(.vertical, 9)
                HStack(spacing: 12) {
                    HintView(hint: Hint(key: "Tab", label: AskCopy.answerLabel(question)))
                    if question.ask.pick == .many { HintView(hint: Hint(key: "Space", label: "Select")) }
                    HintView(hint: Hint(key: "Esc", label: "Dismiss"))
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 9)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Caret's question")
        .accessibilityAction(named: Text(AskCopy.answerLabel(question)), onAnswer)
        .accessibilityAction(named: Text("Dismiss"), onEscape)
    }
}

/// One choice: 26 tall, the words and their quieter detail, a box at the left for a fields question.
private struct AskChoiceRow: View {
    var option: AskQuestion.Option
    var highlighted: Bool
    /// Nil for a question that takes one answer.
    var selected: Bool?

    static let indent: CGFloat = 12

    var body: some View {
        let words = AskCopy.option(option)
        HStack(spacing: 8) {
            if let selected { Box(on: selected) }
            Text(words.title)
                .font(Tokens.Font.chrome)
                .foregroundStyle(Color(token: highlighted ? Tokens.ink : Tokens.ink2))
                .lineLimit(1)
                .truncationMode(.middle)
            if let detail = words.detail {
                Text(detail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, Self.indent)
        .frame(height: 26)
        .overlay(alignment: .leading) {
            if highlighted { Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2, height: 18) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words.detail.map { "\(words.title), \($0)" } ?? words.title)
        .accessibilityAddTraits(highlighted ? .isSelected : [])
        .accessibilityValue(selected.map { $0 ? "Selected" : "Not selected" } ?? "")
    }

    /// A 12 pt box in Ink 2, filled in Ink with a check when selected.
    private struct Box: View {
        var on: Bool

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 3, style: .continuous)
            ZStack {
                shape.fill(Color(token: on ? Tokens.inkFill : Tokens.keyFill))
                shape.strokeBorder(Color(token: on ? Tokens.inkFill : Tokens.keyEdge), lineWidth: 1)
                if on {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Color(token: Tokens.onInk))
                }
            }
            .frame(width: 12, height: 12)
        }
    }
}

/// The keys the card names, also as VoiceOver actions, so it never depends on knowing them.
private struct CardActions: ViewModifier {
    var proposed: Bool
    var running: Bool
    var undoable: Bool
    var action: String
    var onRun: () -> Void
    var onEscape: () -> Void
    var onUndo: () -> Void

    func body(content: Content) -> some View {
        if proposed {
            content.accessibilityAction(named: Text(action), onRun).accessibilityAction(named: Text("Dismiss"), onEscape)
        } else if running {
            content.accessibilityAction(named: Text("Stop"), onEscape)
        } else if undoable {
            content.accessibilityAction(named: Text("Undo"), onUndo).accessibilityAction(named: Text("Close"), onEscape)
        } else {
            content.accessibilityAction(named: Text("Close"), onEscape)
        }
    }
}

/// One step: a mark for its state and the words. To do is a 7 pt ring; the step running now is a
/// lit 7 pt Carrot dot with the glow, its light pulsing over 1.6 s (state indication, held still
/// under Reduce Motion); done is a check in Ink 2. A press left to the user says "You do this" in
/// Carrot text, and Caret never marks it done.
struct AskStepRow: View {
    var step: AskCaret.Step
    /// The run has started: a step not reached yet steps back to Ink 2. Before Tab every step is
    /// Ink, so what Caret would do never reads quieter than what it leaves to the user.
    var started = false
    var animated = true

    static let markWidth: CGFloat = 10

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            StepMark(state: step.state, animated: animated)
                .frame(width: Self.markWidth, height: Self.markWidth)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(step.text)
                .font(Tokens.Font.chrome)
                .foregroundStyle(Color(token: started && step.state == .pending && !step.yours ? Tokens.ink2 : Tokens.ink))
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
            if step.yours {
                Text(AskCopy.yours)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(Color(token: Tokens.carrotText))
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(step.yours ? "\(step.text). \(AskCopy.yours)." : step.text)
        .accessibilityValue(stateWords)
    }

    private var stateWords: String {
        switch step.state {
        case .pending: return step.yours ? "" : "Not done yet"
        case .running: return "In progress"
        case .done: return "Done"
        case .failed: return "Stopped here"
        }
    }
}

private struct StepMark: View {
    var state: AskCaret.Step.State
    var animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch state {
        case .pending:
            Circle().strokeBorder(Color(token: Tokens.ink3), lineWidth: 1).frame(width: 7, height: 7)
        case .running:
            // The light is a ring around the dot, clear of it, so the dot stands on the card (3:1 as a
            // mark; on its own glow it fell to 2.9). Only the ring's opacity pulses (1.6 s, the spec's
            // "lit step"): nothing is laid out or re-blurred per frame. Still under Reduce Motion.
            let pulses = animated && !reduceMotion
            ZStack {
                Circle().strokeBorder(Color(token: Tokens.glow), lineWidth: 2).frame(width: 14, height: 14).blur(radius: 0.8)
                    .phaseAnimator(pulses ? [0.35, 1.0] : [1.0]) { glow, strength in glow.opacity(strength) } animation: { _ in .easeInOut(duration: 0.8) }
                Circle().fill(Color(token: Tokens.carrot)).frame(width: 7, height: 7)
            }
        case .done:
            Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
        case .failed:
            Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
        }
    }
}

/// The live field: `AskSection` over the observed model, announcing a new plan or ending to VoiceOver.
struct AskLiveSection: View {
    @ObservedObject var model: AskModel
    var character: FigureCharacter
    var animated: Bool

    var body: some View {
        AskSection(
            text: model.text, phase: model.phase, character: character, focusToken: model.focusToken, animated: animated, notRight: model.notRight,
            onEdit: { model.edit($0) }, onSubmit: { model.submit() }, onRun: { model.run() }, onEscape: { model.escape() }, onUndo: { model.undo() },
            onNotRight: { model.notRightAction($0) }
        )
        .onChange(of: announcement) { _, words in
            if let words { AccessibilityNotification.Announcement(words).post() }
        }
    }

    /// What VoiceOver says when the phase changes: the plan's title, the reason there is none, or the ending.
    private var announcement: String? {
        switch model.phase {
        case .idle: return nil
        case .running(let card): return "Running in \(card.app). Escape stops it."
        case .asking: return AskCopy.planning
        case .failed(let sentence): return sentence
        case .proposed(let card): return "\(card.title). Tab to \(card.action.lowercased()), Escape to dismiss."
        // Said once when the question comes; moving between rows is the rows' own selected state.
        case .question(let q): return "\(q.ask.text) \(q.ask.options.count) choices."
        case .ended(_, let line): return line.text
        }
    }
}
