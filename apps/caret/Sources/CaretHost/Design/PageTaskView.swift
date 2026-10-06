import AppKit
import CaretHostCore
import SwiftUI

/// The page task panel (brief H11; fast-browser.md "UI moments"): one glass panel at the form, from the
/// preview to the end, drawn from a `PageTaskPanel`. It lives in the pop-up's family (DIRECTION.md 5.4):
/// radius 12, padding 10 12 9, the figure at 16 beside a title in Caret's voice, rows 24 pt in, keys under a
/// hairline. The rows' labels are field names, longer than an event card's, so their column is wider.
///
/// One thing is particular to it: while Caret writes, a thin Carrot line sits under the row being written,
/// and it moves down the form row by row as the receipts come. Nothing else moves while the page fills: a
/// row resolves in place, at once (the helper's receipts come tens a second; the rows are the progress).
struct PageTaskView: View {
    var panel: PageTaskPanel
    var character: FigureCharacter
    var animated = true

    @Environment(\.voiceFace) private var face
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion

    static let indent: CGFloat = PopupView.indent
    /// A field's label column: "Country of residence" fits at 12.5 pt; a longer label is cut at its end.
    static let labelColumn: CGFloat = 112
    static let width: CGFloat = 340

    private var reduced: Bool { reduceMotion || reducesMotion }

    var body: some View {
        content
            // The next page: the same panel, its content crossfading through a 2 pt blur (UI moment 5).
            .id(panel.page)
            .transition(reduced || !animated ? .opacity : .modifier(active: BlurFade(blur: 2, opacity: 0), identity: BlurFade(blur: 0, opacity: 1)))
            .padding(.top, 10)
            .padding(.bottom, 9)
            .padding(.horizontal, 12)
            .frame(width: Self.width, alignment: .leading)
            .background(alignment: .topLeading) {
                Cast(strength: figure == .error ? 0 : 1, diameter: 64)
                    .offset(x: 12 + PopupView.figureSize / 2 - 32, y: 10 + 10 - 32)
            }
            .panelChrome(radius: Tokens.Shape.popupRadius)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(panel.spoken)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let from = panel.from {
                Text(from)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, Self.indent)
                    .padding(.top, 2)
            }
            ForEach(Array(panel.sections.enumerated()), id: \.offset) { i, section in
                sectionView(section, first: i == 0)
                    // A revealed group fades in where it will stay (UI moment 3): opacity only.
                    .transition(.opacity)
            }
            if !panel.yours.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(panel.yours.enumerated()), id: \.offset) { _, line in
                        Text(line.text)
                            .font(Tokens.Font.chrome.weight(.medium))
                            .foregroundStyle(Color(token: Tokens.carrotText))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.leading, Self.indent)
                .padding(.top, 6)
            }
            if !panel.hints.isEmpty {
                Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1).padding(.top, 8).padding(.bottom, 8)
                HStack(spacing: Tokens.Shape.keysGap) {
                    ForEach(Array(panel.hints.enumerated()), id: \.offset) { _, hint in HintView(hint: hint) }
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            FigureView(character: character, state: figure, facing: .right, size: PopupView.figureSize, animated: animated)
                .frame(width: PopupView.figureSlot)
                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
            (panel.lead.map { Text("\($0) ").font(Tokens.Font.voiceLarge(face).weight(.semibold)).foregroundColor(Color(token: Tokens.carrotText)) } ?? Text(""))
                .font(Tokens.Font.voiceLarge(face))
                + Text(panel.title).font(Tokens.Font.voiceLarge(face)).foregroundColor(Color(token: Tokens.ink))
        }
        .lineLimit(4)
        .fixedSize(horizontal: false, vertical: true)
        .frame(minHeight: 20, alignment: .leading)
    }

    @ViewBuilder
    private func sectionView(_ section: PageTaskPanel.Section, first: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let caption = section.caption {
                // A continuation: under a hairline, what appeared, in Caret's voice (UI moment 3).
                Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1).padding(.top, 8)
                Text(caption)
                    .font(Tokens.Font.voice(face))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .padding(.leading, Self.indent)
                    .padding(.top, 7)
            }
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(section.lines.enumerated()), id: \.offset) { _, line in
                    PageTaskRow(line: line, marks: section.marks)
                }
            }
            .font(Tokens.Font.chrome)
            .padding(.top, first ? 7 : 5)
        }
    }

    private var figure: FigureState {
        switch panel.figure {
        case .offering: return .offering
        case .working: return .working
        case .done: return .done
        case .stopped: return .still
        }
    }
}

/// One row. A field: its label in Ink 2 in the key column, the value in Ink, then "(picked from the list)"
/// or "already so" in Ink 2. A sentence: the helper's words. Withheld: Ink 2, whole. Once the group runs,
/// a mark stands in the indent: a ring to do, a check when written, a cross where it stopped. Words, not
/// colors: success is not green and failure is not red (DIRECTION.md).
private struct PageTaskRow: View {
    var line: PageTaskPanel.Line
    var marks: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            mark
                .frame(width: PageTaskView.indent, alignment: .leading)
            switch line.kind {
            case .field:
                Text(line.label ?? "")
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: PageTaskView.labelColumn, alignment: .leading)
                    .padding(.trailing, 8)
                value
            case .step:
                value
            case .withheld:
                Text(line.text)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
            case .yours:
                Text(line.text).foregroundStyle(Color(token: Tokens.carrotText))
            }
        }
    }

    /// The value with its note beside it, or the note on the line under it when both do not fit: a long pick
    /// ("University of Waterloo") keeps "(picked from the list)" whole rather than cutting it.
    private var value: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                valueText.fixedSize()
                noteText.fixedSize()
            }
            VStack(alignment: .leading, spacing: 0) {
                valueText
                noteText
            }
        }
    }

    @ViewBuilder private var noteText: some View {
        if let note = line.note {
            Text(note).font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2)).lineLimit(1)
        }
    }

    /// The value, and while it is being written the thin Carrot line under it: the one moving thing.
    private var valueText: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(line.text)
                .foregroundStyle(Color(token: line.state == .failed ? Tokens.ink2 : Tokens.ink))
                .lineLimit(1)
                .truncationMode(.tail)
                .overlay(alignment: .bottom) {
                    if line.state == .writing {
                        Rectangle().fill(Color(token: Tokens.carrot)).frame(height: 1.25).offset(y: 2)
                    }
                }
                .layoutPriority(1)
        }
    }

    @ViewBuilder private var mark: some View {
        if marks, line.kind == .field || line.kind == .step {
            switch line.state {
            case .pending?, .writing?:
                Circle().strokeBorder(Color(token: Tokens.ink3), lineWidth: 1).frame(width: 7, height: 7)
            case .verified?:
                Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
            case .failed?:
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
            case .already?, nil:
                Color.clear.frame(width: 7, height: 7)
            }
        } else {
            Color.clear.frame(width: 7, height: 7)
        }
    }
}

/// The blur-and-fade a page's content crosses with (UI moment 5).
private struct BlurFade: ViewModifier {
    var blur: CGFloat
    var opacity: Double

    func body(content: Content) -> some View {
        content.blur(radius: blur).opacity(opacity)
    }
}

/// The panel's live model: the coordinator sets it inside the motion the change calls for.
@MainActor
final class PageTaskModel: ObservableObject {
    @Published var panel: PageTaskPanel?
    /// Off for a change a key made: nothing in the panel moves for Tab, Esc or ⌘Z, the figure included.
    @Published var animated = true
}

/// The panel as the hosted panel shows it, over the observed model.
struct PageTaskLiveView: View {
    @ObservedObject var model: PageTaskModel
    var character: FigureCharacter
    var animated: Bool

    var body: some View {
        if let panel = model.panel {
            PageTaskView(panel: panel, character: character, animated: animated && model.animated)
        }
    }
}
