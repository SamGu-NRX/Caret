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
    /// H14: a click on attach row `step`, the same as its ⌘ key.
    var onAttach: (Int) -> Void = { _ in }

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
                    if line.kind == .attach, let a = line.attach {
                        AttachRow(line: line, attach: a, onAttach: onAttach)
                    } else {
                        PageTaskRow(line: line, marks: section.marks)
                    }
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
            case .attach:
                // Drawn by `AttachRow`; a section never hands one here.
                value
            }
        }
    }

    /// The value with its note beside it, or the note on the line under it when both do not fit: a long pick
    /// ("University of Waterloo") keeps "(picked from the list)" whole rather than cutting it.
    @ViewBuilder private var value: some View {
        if line.wraps {
            // A file's name and date, whole (H14): the text wraps in its column.
            valueText
        } else {
            fitting
        }
    }

    private var fitting: some View {
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
                .lineLimit(line.wraps ? nil : 1)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: line.wraps)
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

/// H14: an attach row in a preview. The control's name in the key column, as a field's label is; then "Choose a
/// file…" in Carrot text (the next step is the user's), or the file, whole: name and last-edited date wrap rather
/// than cut, so a stale résumé shows as one. The row's key sits at the trailing edge: "⌘2", "⌘2 Attach" on a saved
/// file not yet confirmed, "⌘2 Change" once it is the file Tab sends, which a paperclip in the indent marks. Why the
/// last file was not taken sits under it in Ink.
///
/// The row is a button: a click does what its key does. It takes no focus (the panel never becomes key) and shows a
/// key-fill wash under the pointer (120 ms opacity); nothing moves, since the change a click makes is drawn at once.
private struct AttachRow: View {
    var line: PageTaskPanel.Line
    var attach: PageTaskPanel.Line.Attach
    var onAttach: (Int) -> Void

    @State private var hovering = false

    var body: some View {
        Button { onAttach(attach.step) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Group {
                    if attach.state == .confirmed {
                        Image(systemName: "paperclip").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
                    } else {
                        Color.clear.frame(width: 7, height: 7)
                    }
                }
                .frame(width: PageTaskView.indent, alignment: .leading)
                // A file control's name tells a file input from a dropzone, so it may take a second line.
                Text(line.label ?? "")
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: PageTaskView.labelColumn, alignment: .leading)
                    .padding(.trailing, 8)
                VStack(alignment: .leading, spacing: 1) {
                    // The key beside the file when both fit on one line, else under it: the file keeps the width.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            fileText.fixedSize()
                            Spacer(minLength: 0)
                            keyHint
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            fileText.fixedSize(horizontal: false, vertical: true)
                            keyHint
                        }
                    }
                    if let note = line.note {
                        Text(note)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Color(token: Tokens.keyFill))
                    .padding(.horizontal, -4)
                    .opacity(hovering ? 1 : 0)
                    // The memory rows' pointer fade (`MemoryRowView.pointerFade`): opacity only, so it stays under Reduce Motion.
                    .animation(MemoryRowView.pointerFade, value: hovering)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel([line.label, line.text, line.note].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(attach.state == .offered ? "Attaches this file when you press Tab." : "Opens a file chooser.")
    }

    private var fileText: some View {
        Text(line.text).foregroundStyle(Color(token: attach.state == .choose ? Tokens.carrotText : Tokens.ink))
    }

    @ViewBuilder private var keyHint: some View {
        if let key = attach.key { HintView(hint: Hint(key: key, label: attach.action)) }
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
    /// H14: a click on an attach row.
    var onAttach: (Int) -> Void = { _ in }
}

/// The panel as the hosted panel shows it, over the observed model.
struct PageTaskLiveView: View {
    @ObservedObject var model: PageTaskModel
    var character: FigureCharacter
    var animated: Bool

    var body: some View {
        if let panel = model.panel {
            PageTaskView(panel: panel, character: character, animated: animated && model.animated, onAttach: model.onAttach)
        }
    }
}
