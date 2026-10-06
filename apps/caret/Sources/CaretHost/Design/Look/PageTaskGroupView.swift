import AppKit
import CaretHostCore
import SwiftUI

extension VerticalAlignment {
    /// The top of the panel's first rows: the crop's window lines up with it, its caption just above.
    private enum RowsTop: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[.top] }
    }

    static let rowsTop = VerticalAlignment(RowsTop.self)
}

/// The page panel and its crop in one view, so the hairline between them is drawn in one space and the two can never
/// drift apart (v41 BUILD-FIRST 1, "The view"): the panel, the crop 22 pt to its side (or over its rows when the screen
/// has no room), and the thread from the row's edge to the span's line in the crop.
struct PageTaskGroupView: View {
    var panel: PageTaskPanel
    /// The goal step whose crop shows; nil shows none.
    var crop: Int?
    var side: PageTaskLook.CropSide
    var character: FigureCharacter
    var animated = true
    var figure: PageTaskLook.Figure = PageTaskLook.figure
    var now = Date()
    var onAttach: (Int) -> Void = { _ in }

    @Environment(\.lookMotion) private var motion

    var body: some View {
        let content = crop.flatMap { Self.cropContent(panel, step: $0) }
        Group {
            switch side {
            case .trailing, .leading:
                HStack(alignment: .rowsTop, spacing: LookShape.cropGap) {
                    if side == .leading { cropView(content) }
                    PageTaskView(panel: panel, character: character, animated: animated, figure: figure, onAttach: onAttach)
                    if side == .trailing { cropView(content) }
                }
            case .overlay:
                ZStack(alignment: Alignment(horizontal: .trailing, vertical: .rowsTop)) {
                    PageTaskView(panel: panel, character: character, animated: animated, figure: figure, onAttach: onAttach)
                    cropView(content).padding(.trailing, 6)
                }
            }
        }
        .coordinateSpace(name: LookSpace.group)
        .environment(\.lookFocus, panel.sections.contains { $0.marks && $0.lines.contains { $0.state == .writing } } ? nil : crop)
        .overlayPreferenceValue(LookGeometryKey.self) { geometry in
            if side != .overlay, let step = content?.step, let row = geometry.rows[step], let crop = geometry.crop {
                PageTaskThread(row: row, crop: crop, spanY: geometry.spanY, side: side, writing: Self.line(panel, step: step)?.state == .writing)
            }
        }
    }

    @ViewBuilder private func cropView(_ content: CropContent?) -> some View {
        if let content {
            SourceCropView(content: content, now: now)
                .alignmentGuide(.rowsTop) { $0[.top] + LookShape.cropCaption }
                .background {
                    GeometryReader { g in Color.clear.preference(key: LookGeometryKey.self, value: LookGeometry(crop: g.frame(in: .named(LookSpace.group)))) }
                }
                .transition(motion.rises
                            ? .asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: side == .leading ? .topTrailing : .topLeading)).combined(with: .offset(y: 2)), removal: .opacity)
                            : .opacity)
        }
    }

    /// The row a step is, in any section.
    static func line(_ panel: PageTaskPanel, step: Int) -> PageTaskPanel.Line? {
        let lines: [PageTaskPanel.Line] = panel.sections.flatMap(\.lines)
        return lines.first { (l: PageTaskPanel.Line) -> Bool in l.step == step && l.kind != .attach }
    }

    /// What the crop shows for `step`: the source with every row from the same drawing marked (written rows settled,
    /// the writing row's rule, the focused row's band), or a blank's sentence. Nil when the row has neither.
    static func cropContent(_ panel: PageTaskPanel, step: Int) -> CropContent? {
        let lines = panel.sections.flatMap(\.lines)
        guard let line = lines.first(where: { $0.step == step }) else { return nil }
        if let blank = line.blank {
            return CropContent(step: step, body: .blank(label: line.label ?? "", blank: blank, sentence: line.text))
        }
        guard let e = line.excerpt else { return nil }
        var marks: [CropContent.Mark] = []
        for other in lines {
            guard let o = other.excerpt, o.text == e.text, o.name == e.name, other.sourceKind == line.sourceKind else { continue }
            switch other.state {
            case .writing?: marks.append(.init(range: o.nsSpan, kind: .writing))
            case .verified?, .already?: marks.append(.init(range: o.nsSpan, kind: .done))
            case .pending?, .failed?, nil: if other.step == step { marks.append(.init(range: o.nsSpan, kind: .focus)) }
            }
        }
        // The shown row's mark last, so it leads the pan when nothing is being written.
        if let i = marks.firstIndex(where: { $0.range == e.nsSpan }), i != marks.count - 1 { marks.append(marks.remove(at: i)) }
        let app = line.sourceKind == .memory || line.sourceKind == .request ? nil : line.owner
        return CropContent(step: step, body: .source(e, kind: line.sourceKind, app: app, marks: marks))
    }
}

/// The hairline from the row to its source (v41 3.2, BUILD-FIRST "The thread"): a cubic from the row's edge to the
/// crop's edge at the span's line, clamped 6 pt inside the window, so it never crosses the user's text; control points
/// at 90% of the gap; a 1.6 pt dot at the crop end. At rest 1 pt Ink 2 at 75%; while the row is written, 1.5 pt Carrot
/// drawing on the row's clock.
private struct PageTaskThread: View {
    var row: CGRect
    var crop: CGRect
    var spanY: CGFloat?
    var side: PageTaskLook.CropSide
    var writing: Bool

    var body: some View {
        let windowTop = crop.minY + LookShape.cropCaption
        let y = min(max(spanY ?? (windowTop + LookShape.cropWindow / 2), windowTop + 6), windowTop + LookShape.cropWindow - 6)
        let start = CGPoint(x: side == .leading ? row.minX - 3 : row.maxX + 3, y: row.midY)
        let end = CGPoint(x: side == .leading ? crop.maxX : crop.minX, y: y)
        ThreadLine(start: start, end: end, writing: writing)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct ThreadLine: View {
    var start: CGPoint
    var end: CGPoint
    var writing: Bool
    @Environment(\.lookMotion) private var motion
    @State private var drawn = false

    var body: some View {
        let dx = end.x - start.x
        let path = Path { p in
            p.move(to: start)
            p.addCurve(to: end, control1: CGPoint(x: start.x + dx * 0.9, y: start.y), control2: CGPoint(x: end.x - dx * 0.9, y: end.y))
        }
        let color = Color(token: writing ? CaretColor.carrotThread : CaretColor.pencilThread).opacity(writing ? 1 : 0.75)
        ZStack(alignment: .topLeading) {
            path.trim(from: 0, to: trimmed ? (drawn ? 1 : 0) : 1)
                .stroke(color, style: StrokeStyle(lineWidth: writing ? 1.5 : 1, lineCap: .round))
            Circle().fill(color).frame(width: 3.2, height: 3.2).position(end)
        }
        .onAppear {
            guard trimmed else { return }
            withAnimation(CaretMotion.out(motion.thread)) { drawn = true }
        }
        .animation(CaretMotion.fade(motion.settle), value: writing)
    }

    /// The writing thread draws on the row's clock; the resting one and every keyed change appear whole.
    private var trimmed: Bool { writing && motion.thread != nil }
}
