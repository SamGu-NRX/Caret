import AppKit
import CaretHostCore
import SwiftUI

/// The page task panel (brief H11; L1 builds design/v41's look): one glass panel at the form, from the preview to the
/// end, drawn from a `PageTaskPanel`. 340 wide, radius 10 (v41 2.4): a head (the figure, Caret's sentence, where the
/// values come from), the rows under a hairline in v41's grammar (mark · label · value · owner, `LookRow`), and the keys
/// under a hairline. While Caret writes, the row being written carries the Carrot rule; the crop beside the panel
/// (`PageTaskGroupView`) carries the same rule under the value's span in its source.
struct PageTaskView: View {
    var panel: PageTaskPanel
    var character: FigureCharacter
    var animated = true
    /// The mark beside the title (`PageTaskLook.figure`); the gallery renders each option.
    var figure: PageTaskLook.Figure = PageTaskLook.figure
    /// H14: a click on attach row `step`, the same as its ⌘ key.
    var onAttach: (Int) -> Void = { _ in }

    @Environment(\.lookMotion) private var motion

    static let width: CGFloat = LookShape.panelWidth
    /// The rows' inset from the panel's edges (v41: rows 3 10 4 8).
    static let rowInset = EdgeInsets(top: 3, leading: 8, bottom: 4, trailing: 10)

    var body: some View {
        content
            // The next page: the same panel, its content crossing through a 2 pt blur (`swap`, a whole panel 200 ms).
            .id(panel.page)
            .transition(motion.blurs ? .modifier(active: BlurFade(blur: 2, opacity: 0), identity: BlurFade(blur: 0, opacity: 1)) : .opacity)
            .frame(width: Self.width, alignment: .leading)
            .lookPanel()
            .background {
                GeometryReader { g in Color.clear.preference(key: LookGeometryKey.self, value: LookGeometry(panel: g.frame(in: .named(LookSpace.group)))) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel([panel.lead, panel.title].compactMap { $0 }.joined(separator: " "))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageTaskHead(panel: panel, character: character, animated: animated, figure: figure)
            ForEach(Array(panel.sections.enumerated()), id: \.offset) { i, section in
                PageTaskSection(section: section, first: i == 0, onAttach: onAttach, offset: rowOffset(before: i))
                    // A revealed group fades in where it will stay: opacity only.
                    .transition(.opacity)
            }
            if !panel.yours.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(panel.yours.enumerated()), id: \.offset) { i, line in
                        LookRow(line: line, index: i)
                    }
                }
                .padding(Self.rowInset)
                .overlay(alignment: .top) { Color(token: CaretColor.rule).frame(height: 1) }
            }
            if !panel.hints.isEmpty {
                PageTaskFoot(hints: panel.hints)
            }
        }
    }

    /// The stagger counts rows across sections, so a panel's first six arrive in order.
    private func rowOffset(before section: Int) -> Int {
        panel.sections.prefix(section).reduce(0) { $0 + $1.lines.count }
    }
}

/// The head: the figure (or none), the sentence in 13 Medium, the lead word in Carrot text; under it where the values
/// came from and how many are the user's, in 11.5 Ink 2, broken at the "·" and never mid-phrase (v41 1).
private struct PageTaskHead: View {
    var panel: PageTaskPanel
    var character: FigureCharacter
    var animated: Bool
    var figure: PageTaskLook.Figure

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            if let slot = LookFigure.slot(figure) {
                LookFigure(option: figure, character: character, state: state)
                    .frame(width: slot, height: slot * 13 / 12)
                    .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 1) {
                (panel.lead.map { Text("\($0) ").foregroundColor(Color(token: CaretColor.carrotText)) } ?? Text(""))
                    + Text(panel.title).foregroundColor(Color(token: CaretColor.ink))
                if panel.from != nil || panel.yoursCount != nil {
                    PageTaskMeta(from: panel.from.map(Self.capitalized), yours: panel.yoursCount)
                }
            }
            .font(LookFont.sentence)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(EdgeInsets(top: 9, leading: LookFigure.slot(figure) == nil ? 12 : 10, bottom: 8, trailing: 12))
    }

    private var state: FigureState {
        switch panel.figure {
        case .offering: return .offering
        case .working: return .working
        case .done: return .done
        case .stopped: return .still
        }
    }

    static func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
}

/// "From Notes and what you told Caret · 1 is yours", or the count on its own line when both do not fit.
private struct PageTaskMeta: View {
    var from: String?
    var yours: String?

    var body: some View {
        Group {
            if let from, let yours {
                ViewThatFits(in: .horizontal) {
                    Text("\(from) · \(yours)").fixedSize()
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(from) ·")
                        Text(yours).fixedSize()
                    }
                }
            } else {
                Text(from ?? yours ?? "")
            }
        }
        .font(LookFont.meta)
        .foregroundStyle(Color(token: CaretColor.ink2))
        .lineSpacing(1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// One group of rows under a hairline; a continuation's caption ("2 more fields appeared") heads it.
private struct PageTaskSection: View {
    var section: PageTaskPanel.Section
    /// The first group: its top is where the crop's window lines up (`VerticalAlignment.rowsTop`).
    var first: Bool
    var onAttach: (Int) -> Void
    var offset: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let caption = section.caption {
                Text(caption)
                    .font(LookFont.meta)
                    .foregroundStyle(Color(token: CaretColor.ink2))
                    .padding(EdgeInsets(top: 7, leading: LookShape.markColumn + LookShape.gap + 2, bottom: 3, trailing: 0))
            }
            ForEach(Array(section.lines.enumerated()), id: \.offset) { i, line in
                if line.kind == .attach, let a = line.attach {
                    AttachRow(line: line, attach: a, onAttach: onAttach)
                } else {
                    LookRow(line: line, index: offset + i)
                }
            }
        }
        .padding(PageTaskView.rowInset)
        .overlay(alignment: .top) { Color(token: CaretColor.rule).frame(height: 1) }
        .modifier(RowsTop(on: first))
    }
}

private struct RowsTop: ViewModifier {
    var on: Bool
    func body(content: Content) -> some View {
        if on { content.alignmentGuide(.rowsTop) { $0[.top] + PageTaskView.rowInset.top } } else { content }
    }
}

/// The keys under a hairline: `Tab Fill 11 · ⌘2 Attach · Esc`. A running panel's lone `Esc Stop` sits at the right.
private struct PageTaskFoot: View {
    var hints: [Hint]

    private var stopOnly: Bool { hints.count == 1 && hints[0].label == "Stop" }

    var body: some View {
        HStack(spacing: 12) {
            if stopOnly { Spacer(minLength: 0) }
            ForEach(Array(hints.enumerated()), id: \.offset) { _, hint in LookHint(hint: hint) }
            if !stopOnly { Spacer(minLength: 0) }
        }
        .padding(EdgeInsets(top: 7, leading: 12, bottom: 8, trailing: 12))
        .overlay(alignment: .top) { Color(token: CaretColor.rule).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// H14: an attach row in a preview. The control's name in the label column, as a field's label is; then "Choose a
/// file…" in Carrot text (the next step is the user's), or the file, whole: name and last-edited date wrap rather
/// than cut, so a stale résumé shows as one. The row's key sits at the trailing edge: "⌘2", "⌘2 Attach" on a saved
/// file not yet confirmed, "⌘2 Change" once it is the file Tab sends, which a paperclip in the mark column marks. Why
/// the last file was not taken sits under it in Ink.
///
/// The row is a button: a click does what its key does. It takes no focus (the panel never becomes key) and shows the
/// focus wash under the pointer (120 ms opacity); nothing moves, since the change a click makes is drawn at once.
private struct AttachRow: View {
    var line: PageTaskPanel.Line
    var attach: PageTaskPanel.Line.Attach
    var onAttach: (Int) -> Void

    @State private var hovering = false

    var body: some View {
        Button { onAttach(attach.step) } label: {
            HStack(alignment: .firstTextBaseline, spacing: LookShape.gap) {
                Group {
                    if attach.state == .confirmed {
                        Image(systemName: "paperclip").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Color(token: CaretColor.ink2))
                    } else {
                        Circle().strokeBorder(Color(token: CaretColor.ink3), lineWidth: 1).frame(width: 5, height: 5)
                    }
                }
                .frame(width: LookShape.markColumn)
                // A file control's name tells a file input from a dropzone, so it may take a second line.
                Text(line.label ?? "")
                    .foregroundStyle(Color(token: CaretColor.ink2))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: LookShape.labelColumn, alignment: .leading)
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
                            .font(LookFont.meta)
                            .foregroundStyle(Color(token: CaretColor.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(LookFont.row)
            .padding(.vertical, 3)
            .padding(.horizontal, 2)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Color(token: CaretColor.focusRow))
                    .opacity(hovering ? 1 : 0)
                    // Opacity only, so it stays under Reduce Motion (`MemoryRowView.pointerFade`).
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
        Text(line.text).foregroundStyle(Color(token: attach.state == .choose ? CaretColor.carrotText : CaretColor.ink))
    }

    @ViewBuilder private var keyHint: some View {
        if let key = attach.key { LookHint(hint: Hint(key: key, label: attach.action)) }
    }
}

/// The blur-and-fade a page's content crosses with.
private struct BlurFade: ViewModifier {
    var blur: CGFloat
    var opacity: Double

    func body(content: Content) -> some View {
        content.blur(radius: blur).opacity(opacity)
    }
}
