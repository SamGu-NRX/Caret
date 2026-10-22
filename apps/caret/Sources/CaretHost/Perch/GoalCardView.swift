import AppKit
import CaretHostCore
import SwiftUI

/// A goal's segment on the desk (`GoalCard`), in the plan card's block and type: the app and part over the place in
/// Caret's voice, each step with its state mark, a drafted message whole in Caret's voice under the field it goes in,
/// what the helper warned about, and last, set apart behind the 2 pt Carrot edge the desk uses for "this needs you",
/// the press that stays the user's: what it sends, to whom, and for what.
///
/// Nothing here animates on Tab, Esc or ⌘E: each follows a key the user is watching (`emil-design-eng`). The running
/// step's dot pulses as the plan card's does, held still under Reduce Motion.
struct GoalCardView: View {
    var card: GoalCard
    var animated = true
    var onRun: () -> Void = {}
    var onEscape: () -> Void = {}
    var onUndo: () -> Void = {}
    var onEdit: () -> Void = {}
    var onDraft: (String) -> Void = { _ in }
    var onKeep: () -> Void = {}

    /// Assumed, not measured on any display: the rows, notes and hand-off scroll past this, so the keys stay on a laptop
    /// screen with the field and the question above them (as AskValueRows.maxHeight is).
    static let maxBody: CGFloat = 340

    private var started: Bool {
        switch card.stage {
        case .running, .stopping, .ended: return true
        case .preview, .editing, .editSent: return false
        }
    }

    var body: some View {
        Block {
            VStack(alignment: .leading, spacing: 0) {
                Text(GoalCopy.eyebrow(card))
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                Text(GoalCopy.title(card))
                    .font(Tokens.Font.voiceLarge(.newYork))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 1)
                    .accessibilityAddTraits(.isHeader)
                ScrollingCap(max: Self.maxBody, scrolls: !isEditing) { content }
                    .padding(.top, 8)
                // Outside the scroll: the press that stays the user's is always in view with the keys.
                if let handOff = GoalCopy.handOff(card) {
                    GoalHandOffView(handOff: handOff).padding(.top, 10)
                }
                Hairline().padding(.vertical, 9)
                footer
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 9)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Caret's plan, \(GoalCopy.eyebrow(card))")
        .modifier(GoalCardActions(card: card, onRun: onRun, onEscape: onEscape, onUndo: onUndo, onEdit: onEdit, onKeep: onKeep))
    }

    private var isEditing: Bool { if case .editing = card.stage { return true } else { return false } }

    /// The rows, then what the helper warned about.
    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(card.listed, id: \.step) { row in
                    GoalRowView(row: row, started: started, animated: animated, editing: editingText(row), yours: card.edited.contains(row.step), onDraft: onDraft)
                }
            }
            if !card.warnings.isEmpty || card.note != nil {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(card.warnings.enumerated()), id: \.offset) { _, w in GoalNote(text: w) }
                    if let note = card.note { GoalNote(text: note, strong: true) }
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func editingText(_ row: GoalCard.Row) -> String? {
        if case .editing(let step, let text) = card.stage, step == row.step { return text }
        return nil
    }

    @ViewBuilder private var footer: some View {
        switch card.stage {
        case .preview:
            HStack(spacing: 12) {
                HintView(hint: Hint(key: "Tab", label: GoalCopy.action(card)))
                // A short label: a field name can run long, and the keys share one line. VoiceOver's action names the field.
                if card.editable != nil { HintView(hint: Hint(key: "\u{2318}E", label: "Edit")) }
                HintView(hint: Hint(key: "Esc", label: "Dismiss"))
                Spacer(minLength: 0)
            }
        case .editing:
            HStack(spacing: 12) {
                Text(GoalCopy.editing).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HintView(hint: Hint(key: "\u{21A9}", label: "Keep"))
                HintView(hint: Hint(key: "Esc", label: "Cancel"))
            }
        case .editSent:
            Text("Checking your words").font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
        case .running:
            HStack(spacing: 12) {
                Text(GoalCopy.working(card.place)).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
                    .frame(maxWidth: .infinity, alignment: .leading)
                HintView(hint: Hint(key: "Esc", label: "Stop"))
            }
        case .stopping:
            Text(Captions.stopping).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
        case .ended(let e):
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(e.line)
                    .font(.system(size: 13, weight: .medium, design: .serif))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if card.undoable { HintView(hint: Hint(key: "\u{2318}Z", label: "Undo")) }
                HintView(hint: Hint(key: "Esc", label: "Close"))
            }
        }
    }
}

/// One step: the plan card's mark and words. A write Caret drafted shows the field's name on its line and the whole
/// draft under it in Caret's voice, marked as Caret's; while ⌘E has it open, a field holds the words instead.
private struct GoalRowView: View {
    var row: GoalCard.Row
    var started: Bool
    var animated: Bool
    var editing: String?
    /// The words are the user's own, from an edit of Caret's draft.
    var yours: Bool
    var onDraft: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AskStepRow(step: step, started: started, animated: animated)
            if let editing {
                DraftEditor(text: editing, onChange: onDraft)
                    .padding(.leading, AskStepRow.markWidth + 8)
            } else if let words = whole {
                DraftBlock(text: words, by: row.drafted != nil ? GoalCopy.draftedBy : GoalCopy.yourWords).padding(.leading, AskStepRow.markWidth + 8)
            }
        }
    }

    /// The words shown whole under the field's name: Caret's draft, or the user's words that replaced it.
    private var whole: String? { row.drafted ?? (yours ? row.value : nil) }

    /// The row as the plan card's step: a drafted write reads only its field's name, since its words show whole below.
    private var step: AskCaret.Step {
        let state: AskCaret.Step.State
        switch row.state {
        case .pending: state = .pending
        case .running: state = .running
        case .done, .skipped: state = .done
        case .failed: state = .failed
        }
        let text = whole != nil || editing != nil ? (row.field ?? row.says) : row.says
        return AskCaret.Step(text: text, yours: !row.caretDoes, state: state, field: row.field)
    }
}

/// A draft whole, in Caret's voice, behind a 1 pt Ink 3 rule: the words are Caret's until the user takes them.
private struct DraftBlock: View {
    var text: String
    /// Whose words: Caret's draft, or the user's.
    var by: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(text)
                .font(Tokens.Font.voice(.newYork))
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Text(by)
                .font(.system(size: 11.5))
                .foregroundStyle(Color(token: Tokens.ink2))
        }
        .padding(.leading, 9)
        .overlay(alignment: .leading) { Rectangle().fill(Color(token: Tokens.ink3)).frame(width: 1) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(by): \(text)")
    }
}

/// The draft open for the user's words: a field that wraps to eight lines, focused as it opens, with the desk's
/// Carrot focus ring. Return keeps the words (the desk's key handler); Esc closes it. Off screen, where a text field
/// draws a placeholder, the words and a caret in its place.
private struct DraftEditor: View {
    var text: String
    var onChange: (String) -> Void

    @Environment(\.rendersOffscreen) private var offscreen
    @FocusState private var focused: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        content
            .font(Tokens.Font.voice(.newYork))
            .foregroundStyle(Color(token: Tokens.ink))
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .textBackgroundColor), in: shape)
            .overlay { shape.strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1) }
            .overlay {
                if offscreen || focused {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(Color(token: Tokens.carrot), lineWidth: 2)
                        .padding(-2)
                }
            }
    }

    @ViewBuilder private var content: some View {
        if offscreen {
            (Text(text) + Text("|").foregroundColor(Color(token: Tokens.ink)))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
        } else {
            TextField("Message", text: Binding(get: { text }, set: onChange), axis: .vertical)
                .textFieldStyle(.plain)
                .labelsHidden()
                .lineLimit(1...8)
                .focused($focused)
                .onAppear { focused = true }
                .accessibilityLabel("Your words in place of Caret's draft")
        }
    }
}

/// What the helper warned about, or why the desk turned an edit down: one quiet line each.
private struct GoalNote: View {
    var text: String
    var strong = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: "info.circle")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color(token: Tokens.ink2))
                .accessibilityHidden(true)
            Text(text)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: strong ? Tokens.ink : Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The press that stays the user's, last and apart: the 2 pt Carrot edge, "You press Send" with the plan card's "You
/// do this", and what it sends, to whom and for what (R8), each on its own line under a quiet label.
private struct GoalHandOffView: View {
    var handOff: GoalCopy.HandOff

    var body: some View {
        HStack(spacing: 10) {
            NeedsYouEdge()
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(handOff.press)
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: Tokens.ink))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(AskCopy.yours)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(Color(token: Tokens.carrotText))
                        .fixedSize()
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 2) {
                    if let sends = handOff.sends { line("Sends", sends, lines: 1) }
                    if let to = handOff.to { line("To", to, lines: 1) }
                    if let purpose = handOff.purpose { line("For", purpose, lines: 2) }
                }
            }
            .padding(.vertical, 1)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(GoalCopy.spokenHandOff(handOff))
    }

    private func line(_ label: String, _ value: String, lines: Int) -> some View {
        GridRow {
            Text(label)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .gridColumnAlignment(.leading)
            Text(value)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink))
                .lineLimit(lines)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The card's keys as named VoiceOver actions.
private struct GoalCardActions: ViewModifier {
    var card: GoalCard
    var onRun: () -> Void
    var onEscape: () -> Void
    var onUndo: () -> Void
    var onEdit: () -> Void
    var onKeep: () -> Void

    func body(content: Content) -> some View {
        content.accessibilityActions {
            switch card.stage {
            case .preview:
                Button(GoalCopy.action(card), action: onRun)
                if let row = card.editable { Button("Edit \((row.field ?? "draft").lowercased())", action: onEdit) }
                Button("Dismiss", action: onEscape)
            case .editing:
                Button("Keep your words", action: onKeep)
                Button("Keep Caret's draft", action: onEscape)
            case .editSent:
                Button("Dismiss", action: onEscape)
            case .running:
                Button("Stop", action: onEscape)
            case .stopping:
                EmptyView()
            case .ended:
                if card.undoable { Button("Undo", action: onUndo) }
                Button("Close", action: onEscape)
            }
        }
    }
}

/// Shows `content` at its own height up to `max`, and scrolls it past that, so the card's keys stay on screen. While the
/// edit field is open the content is not put in a scroll view, which would take the field's focus with it; off screen,
/// where a scroll view draws nothing, the content is drawn from the top and cut at `max`.
private struct ScrollingCap<Content: View>: View {
    var max: CGFloat
    var scrolls: Bool
    @ViewBuilder var content: Content

    @Environment(\.rendersOffscreen) private var offscreen

    var body: some View {
        if offscreen {
            CappedHeight(max: max) { content }.clipped()
        } else if !scrolls {
            content
        } else {
            // As AskValueRows: the content measured at the card's width and never seen, then a scroll view of it at
            // that height up to `max`, so a fresh hosting view's fitting size is already right.
            CappedHeight(max: max) {
                content.hidden().accessibilityHidden(true)
                ScrollView(.vertical) { content }
                    .scrollIndicators(.automatic)
                    .scrollBounceBehavior(.basedOnSize)
            }
        }
    }
}
