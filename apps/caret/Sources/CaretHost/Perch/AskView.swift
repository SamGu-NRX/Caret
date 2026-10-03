import CaretHostCore
import SwiftUI

/// What the ask field draws, published for the view. `PerchController` copies `AskCaret`'s state
/// into it, so typing redraws the field inside SwiftUI rather than rebuilding the list panel.
@MainActor
final class AskModel: ObservableObject {
    @Published var text = ""
    @Published var phase: AskCaret.Phase = .idle
    /// Bumped to move keyboard focus into the field.
    @Published var focusToken = 0
    var edit: (String) -> Void = { _ in }
    var submit: () -> Void = {}
}

/// The ask field at the top of the activity list, and under it what Caret made of the request:
/// "Planning", the reason there is no plan, or the plan's card.
///
/// Nothing here animates. Every change follows a key the user pressed (Return, Tab, Esc) or a step
/// of a run they started, many times a day; motion would read as lag (`emil-design-eng`: never
/// animate keyboard-initiated actions). The list panel's own 160 ms entrance is the only motion.
struct AskSection: View {
    var text: String
    var phase: AskCaret.Phase
    var character: FigureCharacter
    var focusToken = 0
    /// Off screen only: draw the field focused.
    var showsFocus = false
    var animated = true
    var onEdit: (String) -> Void = { _ in }
    var onSubmit: () -> Void = {}

    static let fieldTitle = "Ask Caret"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            EntryField(
                title: Self.fieldTitle, text: text, placeholder: AskCopy.placeholder, showsFocus: showsFocus,
                focusToken: focusToken, onChange: onEdit, onSubmit: onSubmit
            )
            .accessibilityHint("Return plans it. Nothing runs until you press Tab.")
            under
        }
    }

    @ViewBuilder private var under: some View {
        switch phase {
        case .idle:
            // Says what Return does and that nothing runs on its own, only while there is a request
            // to send: an empty field needs no instructions.
            if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                HStack(spacing: 5) {
                    Keycap(text: "Return")
                    Text("plans it. Nothing runs until you press Tab.")
                        .font(Tokens.Font.hint)
                        .foregroundStyle(Color(token: Tokens.secondary))
                }
                .padding(.top, 6)
                .accessibilityHidden(true)
            }
        case .asking:
            status(.working, AskCopy.planning, ink: false)
        case .failed(let sentence):
            status(.error, sentence, ink: true)
        case .proposed(let card):
            AskCard(card: card, ending: nil, running: false, character: character, animated: animated).padding(.top, 8)
        case .running(let card):
            AskCard(card: card, ending: nil, running: true, character: character, animated: animated).padding(.top, 8)
        case .ended(let card, let line):
            AskCard(card: card, ending: line, running: false, character: character, animated: animated).padding(.top, 8)
        }
    }

    private func status(_ figure: FigureState, _ words: String, ink: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            FigureView(character: character, state: figure, facing: .right, height: 11, animated: animated)
                .frame(width: PopupView.figureSlot)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(words)
                .font(Tokens.Font.body)
                .foregroundStyle(Color(token: ink ? Tokens.ink : Tokens.secondary))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
    }
}

/// The plan as a card: its title, each step in plain words with the presses left to the user marked
/// "You do this", and what Tab and Esc do; once it runs, each step's state and then the line that
/// says how it ended. The same panel family as a pop-up at the caret: 12 pt rows aligned under a
/// 13 pt title, a hairline over the keys.
struct AskCard: View {
    var card: AskCaret.Card
    var ending: WorkLine?
    var running: Bool
    var character: FigureCharacter
    var animated = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                FigureView(character: character, state: figure, facing: .right, height: PopupView.figureHeight, animated: animated)
                    .frame(width: PopupView.figureSlot)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(card.title)
                    .font(Tokens.Font.title)
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(card.steps.enumerated()), id: \.offset) { _, step in AskStepRow(step: step, started: running || ending != nil) }
                if card.more > 0 {
                    Text("and \(card.more) more \(card.more == 1 ? "field" : "fields")")
                        .font(Tokens.Font.hint)
                        .foregroundStyle(Color(token: Tokens.secondary))
                }
            }
            .padding(.leading, PopupView.indent)
            .padding(.top, 8)
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.vertical, 8)
            footer
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(token: Tokens.card)))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(token: Tokens.border), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Caret's plan")
    }

    private var figure: FigureState {
        if let ending { return ending.content.figure == .absent ? .done : ending.content.figure }
        return running ? .working : .offering
    }

    @ViewBuilder private var footer: some View {
        if let ending {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                (Text(ending.content.lead.map { $0 + " " } ?? "").foregroundColor(Color(token: Tokens.carrotText)).fontWeight(.semibold)
                    + Text(ending.content.text).foregroundColor(Color(token: Tokens.ink)))
                    .font(Tokens.Font.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HintView(hint: Hint(key: "Esc", label: "Close"))
            }
        } else if running {
            HStack(spacing: 12) {
                Text("Working in \(card.app)").font(Tokens.Font.body).foregroundStyle(Color(token: Tokens.secondary))
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

/// One step: a mark for its state, the words, and for a press left to the user the "You do this"
/// tag in the Carrot wash. A step the user does is never marked done by Caret.
struct AskStepRow: View {
    var step: AskCaret.Step
    /// The run has started: a step not reached yet steps back to Secondary. Before Tab every step is
    /// Ink, so what Caret would do never reads quieter than what it leaves to the user.
    var started = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark.frame(width: 10, height: 10)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(step.text)
                .font(Tokens.Font.body)
                .foregroundStyle(Color(token: started && step.state == .pending && !step.yours ? Tokens.secondary : Tokens.ink))
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
            if step.yours {
                Text(AskCopy.yours)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.carrotText))
                    .padding(.horizontal, 6)
                    .frame(height: 16)
                    .background(Capsule().fill(Color(token: Tokens.carrotWash)))
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

    @ViewBuilder private var mark: some View {
        switch step.state {
        case .pending where step.yours:
            // An open ring in Carrot: the user's own step, waiting for them.
            Circle().strokeBorder(Color(token: Tokens.carrot), lineWidth: 1.5)
        case .pending: Circle().strokeBorder(Color(token: Tokens.secondary), lineWidth: 1)
        case .running: Circle().fill(Color(token: Tokens.carrot)).frame(width: 6, height: 6)
        case .done: Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.secondary))
        case .failed: Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.secondary))
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
            text: model.text, phase: model.phase, character: character, focusToken: model.focusToken, animated: animated,
            onEdit: { model.edit($0) }, onSubmit: { model.submit() }
        )
        .onChange(of: announcement) { _, words in
            if let words { AccessibilityNotification.Announcement(words).post() }
        }
    }

    /// What VoiceOver says when the phase changes: the plan's title, the reason there is none, or the ending.
    private var announcement: String? {
        switch model.phase {
        case .idle, .running: return nil
        case .asking: return AskCopy.planning
        case .failed(let sentence): return sentence
        case .proposed(let card): return "\(card.title). Tab to \(card.action.lowercased()), Escape to dismiss."
        case .ended(_, let line): return line.text
        }
    }
}
