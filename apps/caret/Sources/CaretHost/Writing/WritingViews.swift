import AppKit
import CaretHostCore
import SwiftUI

// The writing offer's views (`action-engine-v2.md` section 7): the mark under an error, the
// correction line, and the open alternatives. Drawn from the existing tokens and panel parts, so
// they read as the same app as the ghost text and its alternatives.
//
// No motion. Keyboard acceptance and navigation redraw at once (section 7: "keep current design
// motion out of the new edit path"), and the mark never moves text or flashes. Not wired into the
// live app yet; the gallery renders them off screen.

/// The mark under an error: the uneven wave of the quoted-value underline, at full strength so it
/// reaches 3:1 against the field (`WritingContrastTests`). Carrot under the active error, the one
/// Tab fixes; Graphite under any other error in the sentence, so there is one accent at a time.
/// Increase Contrast darkens the Carrot to the accent text color.
struct WritingMark: View {
    var width: CGFloat
    var active: Bool
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        UnevenUnderline.Wave()
            .stroke(Color(token: color), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: width, height: 3)
            .accessibilityHidden(true)
    }

    var color: NSColor { Self.color(active: active, increasedContrast: contrast == .increased) }

    static func color(active: Bool, increasedContrast: Bool) -> NSColor {
        guard active else { return Tokens.graphite }
        return increasedContrast ? Tokens.carrotText : Tokens.carrot
    }
}

/// The correction line under the active error: the fix with a word of context, then "Tab fix" and
/// "↓ more". The fix is Ink semibold; the context around it is Secondary, so the eye lands on what
/// changes. 28 tall, like every line.
struct CorrectionLineView: View {
    var preview: WritingOffer.Preview
    var hints: [Hint]
    var spoken: String
    var character: FigureCharacter
    /// Set for a correction that needs a choice: the answers, shown as equals.
    var choices: [String]? = nil

    var body: some View {
        HStack(spacing: 0) {
            FigureView(character: character, state: .offering, facing: .right, height: 11, animated: false)
                .frame(width: PopupView.figureSlot)
            Spacer().frame(width: 8)
            words
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 12)
            HStack(spacing: 12) {
                ForEach(Array(hints.enumerated()), id: \.offset) { HintView(hint: $0.element) }
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .frame(height: 28)
        .frame(maxWidth: 360, alignment: .leading)
        .fixedSize()
        .panelChrome(radius: 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    /// The fix in Ink semibold between its context in Secondary. With `choices` (a correction
    /// that needs a choice), each answer in Ink semibold and the "or" between them in Secondary.
    private var words: Text {
        let strong = { (s: String) in Text(s).font(.system(size: 13, weight: .semibold)).foregroundColor(Color(token: Tokens.ink)) }
        let quiet = { (s: String) in Text(s).foregroundColor(Color(token: Tokens.secondary)) }
        if let choices, !choices.isEmpty {
            return choices.dropFirst().reduce(strong(WritingCopy.visible(choices[0]))) { $0 + quiet(" or ") + strong(WritingCopy.visible($1)) }
        }
        return quiet(preview.before) + strong(preview.replacement) + quiet(preview.after)
    }
}

/// The alternatives, open: why, then a row for each fix, Original and Fix all, the highlighted row
/// in the Carrot wash with a 2 pt edge (the picker's row). When Fix all is highlighted, its whole
/// diff shows under the rows before Tab can apply it. The bottom names what Tab does now.
struct WritingAlternativesView: View {
    var offer: WritingOffer

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(offer.active.reason)
                .font(Tokens.Font.hint)
                .foregroundStyle(Color(token: Tokens.secondary))
                .padding(.leading, PopupView.indent)
                .frame(height: 20, alignment: .center)
            ForEach(Array(offer.alternatives.enumerated()), id: \.offset) { index, alternative in
                WritingAlternativeRow(
                    alternative: alternative,
                    number: index < WritingOffer.numberedRows ? index + 1 : nil,
                    highlighted: index == offer.current
                )
            }
            let highlighted = offer.alternatives[offer.current]
            if highlighted.kind == .fixAll {
                Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.vertical, 6)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(highlighted.diff.enumerated()), id: \.offset) { DiffLine(change: $0.element) }
                }
                .padding(.leading, PopupView.indent)
                .accessibilityElement(children: .combine)
            }
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.vertical, 6)
            HStack(spacing: 12) {
                HintView(hint: Hint(key: "Tab", label: WritingCopy.tabAction(highlighted.kind)))
                HintView(hint: Hint(key: "Esc", label: nil))
            }
            .padding(.leading, PopupView.indent)
        }
        .padding(.top, 4)
        .padding(.bottom, 8)
        .padding(.horizontal, 12)
        .frame(minWidth: 240, maxWidth: 360, alignment: .leading)
        .fixedSize()
        .panelChrome(radius: 8)
    }
}

/// One row: the words Tab would put in, or "Original" with the text kept, or "Fix all in this
/// paragraph" with its count; the Command digit for the first three.
private struct WritingAlternativeRow: View {
    var alternative: WritingOffer.Alternative
    var number: Int?
    var highlighted: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(label).foregroundStyle(Color(token: Tokens.ink)).lineLimit(1)
            Spacer(minLength: 12)
            // On the Carrot wash Secondary falls under 4.5:1 (4.47 light, 4.20 dark), so the
            // highlighted row sets its hint and keycap in Ink.
            if let hint {
                Text(hint).foregroundStyle(Color(token: highlighted ? Tokens.ink : Tokens.secondary)).lineLimit(1)
            }
            if let number { RowKeycap(text: "⌘\(number)", ink: highlighted) }
        }
        .font(Tokens.Font.body)
        .padding(.leading, PopupView.indent)
        .frame(height: 24)
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WritingCopy.spokenAlternative(spokenLabel, number: number, selected: highlighted))
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }

    /// Original shows the kept text as the row and names itself in the hint, so every row's
    /// words are the text that row leaves in the field.
    private var label: String {
        switch alternative.kind {
        case .fix, .fixAll: return alternative.label
        case .original: return alternative.detail ?? alternative.label
        }
    }

    private var hint: String? {
        switch alternative.kind {
        case .fix: return nil
        case .original: return alternative.label
        case .fixAll: return alternative.detail
        }
    }

    private var spokenLabel: String {
        switch alternative.kind {
        case .fix: return alternative.label
        case .original: return "\(alternative.label), “\(alternative.detail ?? "")”"
        case .fixAll: return "\(alternative.label), \(alternative.detail ?? "")"
        }
    }
}

/// `Keycap`, with its label in Ink on a highlighted row.
private struct RowKeycap: View {
    var text: String
    var ink: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(Color(token: ink ? Tokens.ink : Tokens.secondary))
            .padding(.horizontal, 5)
            .frame(height: 16)
            .overlay {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
            }
            .fixedSize()
    }
}

/// One change of the diff: the word before in Secondary, the original struck through in
/// Secondary, then the fix in Ink.
private struct DiffLine: View {
    var change: WritingOffer.Preview

    var body: some View {
        (Text(change.before).foregroundColor(Color(token: Tokens.secondary))
            + Text(WritingCopy.visible(change.original)).strikethrough().foregroundColor(Color(token: Tokens.secondary))
            + Text(" ")
            + Text(WritingCopy.visible(change.replacement)).foregroundColor(Color(token: Tokens.ink))
            + Text(change.after).foregroundColor(Color(token: Tokens.secondary)))
            .font(Tokens.Font.body)
            .lineLimit(1)
            .accessibilityLabel(WritingCopy.fixed(original: change.original, replacement: change.replacement))
    }
}
