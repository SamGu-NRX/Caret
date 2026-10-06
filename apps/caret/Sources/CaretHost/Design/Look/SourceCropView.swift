import AppKit
import CaretHostCore
import SwiftUI

/// What one crop shows: a source's lines with spans marked, or, for a blank row, the blank and its one sentence.
struct CropContent: Equatable {
    struct Mark: Equatable {
        enum Kind: Equatable {
            /// The row under the pointer or VoiceOver: the band and an Ink 2 underline.
            case focus
            /// Being written: the band and the Carrot rule drawing on the row's clock.
            case writing
            /// Written: settled to the Ink 2 underline.
            case done
        }
        var range: NSRange
        var kind: Kind
    }

    enum Body: Equatable {
        case source(SourceExcerpt, kind: RowSource.Kind?, app: String?, marks: [Mark])
        case blank(label: String, blank: PageTaskPanel.Line.Blank, sentence: String)
    }

    /// The row the crop is for (`PageTaskPanel.Line.key`).
    var key: Int
    var body: Body

    /// One drawing per source text: rows whose excerpts are the same text share it, and moving between them moves only
    /// the marks and the pan, never the drawing (v41 3.1).
    var drawingKey: String {
        switch body {
        case .source(let e, let kind, _, _): return "\(kind?.rawValue ?? "")|\(e.name)|\(e.text.hashValue)"
        case .blank(let label, _, _): return "blank|\(label)"
        }
    }
}

/// The crop beside the page panel (v41 DIRECTION 3, BUILD-FIRST 1): a 240 pt mount of the panel's glass with a caption
/// ("About me · Notes · edited Tue") over a 118 pt window onto the user's own source, set in the source's type on opaque
/// paper, the value's span marked. Never a screenshot: the text is the excerpt the helper sent, re-set here.
struct SourceCropView: View {
    var content: CropContent
    var now: Date
    @Environment(\.lookMotion) private var motion
    @Environment(\.calendar) private var calendar

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            caption
                .padding(EdgeInsets(top: 6, leading: 3, bottom: 5, trailing: 3))
                .frame(height: LookShape.cropCaption)
            CropWindow(content: content)
                .id(content.drawingKey)
                .transition(swap)
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 6)
        .frame(width: LookShape.cropWidth)
        .lookPanel(radius: LookShape.cropRadius)
        .animation(CaretMotion.out(motion.swap), value: content.drawingKey)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    /// A new source replaces the old: opacity with a 2 pt blur (`swap`), opacity alone under Reduce Motion.
    private var swap: AnyTransition {
        motion.blurs ? .opacity.combined(with: .modifier(active: CropBlur(radius: 2), identity: CropBlur(radius: 0))) : .opacity
    }

    @ViewBuilder private var caption: some View {
        switch content.body {
        case .source(let e, let kind, let app, _):
            let c = PageTaskCopy.caption(e, kind: kind, app: app, now: now, calendar: calendar)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(c.name).font(LookFont.meta.weight(.medium)).foregroundStyle(Color(token: CaretColor.ink)).lineLimit(1).truncationMode(.tail)
                if let place = c.place { Text(place).font(LookFont.meta).foregroundStyle(Color(token: CaretColor.ink2)).lineLimit(1).truncationMode(.middle) }
                Spacer(minLength: 4)
                // The date is the one fact a stale source needs: it never truncates.
                if let when = c.when { Text(when).font(LookFont.meta).foregroundStyle(Color(token: CaretColor.ink2)).fixedSize() }
            }
        case .blank(let label, _, _):
            Text(label).font(LookFont.meta.weight(.medium)).foregroundStyle(Color(token: CaretColor.ink)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// VoiceOver: where the value came from and the line it is on, never more of the source.
    private var spoken: String {
        switch content.body {
        case .source(let e, let kind, let app, _):
            let c = PageTaskCopy.caption(e, kind: kind, app: app, now: now, calendar: calendar)
            let line = e.span.map { r in e.text[e.text.lineRange(for: r)].trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
            return (["Where this value came from: \(c.name)", c.place, c.when].compactMap { $0 }.joined(separator: ", ")) + ". " + line
        case .blank(let label, _, let sentence):
            return "\(label). \(sentence)"
        }
    }
}

private struct CropBlur: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View { content.blur(radius: radius) }
}

/// The 118 pt window onto the drawing: opaque paper with a 0.5 pt edge and a 1 pt inner shadow at the top left, so it
/// reads as a print set into the glass; 14 pt of fade at the top and 18 at the bottom.
private struct CropWindow: View {
    var content: CropContent
    @Environment(\.lookMotion) private var motion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: LookShape.cropWindowRadius, style: .continuous)
        ZStack(alignment: .topLeading) {
            shape.fill(Color(token: CaretColor.paper))
            switch content.body {
            case .source(let e, let kind, _, let marks):
                SourceDrawing(excerpt: e, kind: kind, marks: marks)
            case .blank(_, let blank, let sentence):
                VStack(alignment: .leading, spacing: 9) {
                    LookBlank(blank: blank, height: 22, maxWidth: .infinity)
                    Text(sentence).font(.system(size: 12)).foregroundStyle(Color(token: CaretColor.paper2))
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
            }
        }
        .frame(height: LookShape.cropWindow)
        .clipShape(shape)
        .overlay { shape.strokeBorder(Color(token: CaretColor.paperEdge), lineWidth: 0.5) }
        .overlay(alignment: .topLeading) {
            // The print's inner shadow at the top left.
            LinearGradient(colors: [Color.black.opacity(0.06), .clear], startPoint: .topLeading, endPoint: .center)
                .frame(height: 3)
                .clipShape(shape)
                .allowsHitTesting(false)
        }
    }
}

/// The source's lines at 1:1, each where TextKit set it, and the span marks under them. The drawing pans so the
/// focused span's line sits 42% down the window.
private struct SourceDrawing: View {
    var excerpt: SourceExcerpt
    var kind: RowSource.Kind?
    var marks: [CropContent.Mark]
    @Environment(\.lookMotion) private var motion

    var body: some View {
        let style = CropStyle.of(kind: kind, pdf: excerpt.pdf != nil)
        let width = LookShape.cropWidth - 12
        let layout = CropLayout(text: excerpt.text, spans: marks.map(\.range), style: style, width: width)
        let lead = marks.first { $0.kind == .writing } ?? marks.first { $0.kind == .focus } ?? marks.last
        let pan = lead.map { layout.pan(to: $0.range, window: LookShape.cropWindow) } ?? 0
        ZStack(alignment: .topLeading) {
            if style.quote {
                Rectangle().fill(Color(token: CaretColor.ink3)).frame(width: 2, height: max(0, layout.height - style.top * 2))
                    .offset(x: 12, y: style.top)
            }
            ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                ForEach(Array(layout.rects(mark.range).enumerated()), id: \.offset) { _, r in
                    SpanMark(kind: mark.kind, rect: r, layout: layout)
                }
            }
            ForEach(Array(layout.lines.enumerated()), id: \.offset) { _, line in
                Text(line.text)
                    .font(style.font)
                    .foregroundStyle(Color(token: CaretColor.paperInk))
                    .lineLimit(1)
                    .fixedSize()
                    .frame(height: style.lineHeight)
                    .offset(x: style.leading, y: line.top)
            }
        }
        .frame(width: width, height: max(layout.height, LookShape.cropWindow), alignment: .topLeading)
        .offset(y: -pan)
        .animation(CaretMotion.inOut(motion.pan), value: pan)
        .frame(height: LookShape.cropWindow, alignment: .top)
        // A fade only where the source goes on past the window: 14 pt at the top, 18 at the bottom.
        .overlay(alignment: .top) { if pan > 0 { PaperFade(top: true).frame(height: 14) } }
        .overlay(alignment: .bottom) { if layout.height - pan > LookShape.cropWindow + 1 { PaperFade(top: false).frame(height: 18) } }
        .background {
            GeometryReader { g in
                let frame = g.frame(in: .named(LookSpace.group))
                // The span's line where the window shows it: its place in the drawing less the pan (prep-for-prod L1-S5).
                let mid = lead.flatMap { layout.rects($0.range).first }.map { frame.minY + $0.midY - pan } ?? (frame.minY + LookShape.cropWindow / 2)
                Color.clear.preference(key: LookGeometryKey.self, value: LookGeometry(spanY: mid))
            }
        }
    }
}

private struct PaperFade: View {
    var top: Bool
    var body: some View {
        LinearGradient(colors: [Color(token: CaretColor.paper), Color(token: CaretColor.paper).opacity(0)], startPoint: top ? .top : .bottom, endPoint: top ? .bottom : .top)
            .allowsHitTesting(false)
    }
}

/// A span's marks (v41 3.2): the band (Ink at 7.5%) behind the words, then an Ink 2 underline at rest, or the Carrot
/// rule drawing while that value is written.
private struct SpanMark: View {
    var kind: CropContent.Mark.Kind
    var rect: CGRect
    var layout: CropLayout
    @Environment(\.lookMotion) private var motion

    var body: some View {
        let boxTop = rect.minY + (layout.style.lineHeight - layout.box) / 2
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 2, style: .continuous).fill(Color(token: CaretColor.band))
                .frame(width: rect.width + 3, height: layout.box + 3)
            // Under the words, 1.5 pt below the baseline.
            Group {
                if kind == .writing {
                    LookWriteRule(rule: motion.rule)
                } else {
                    Color(token: CaretColor.pencil).frame(height: 1).opacity(0.85)
                }
            }
            .frame(width: rect.width + 3)
            .offset(y: 1.5 + layout.ascender + 1.5)
        }
        .offset(x: rect.minX - 1.5, y: boxTop - 1.5)
        .animation(CaretMotion.fade(motion.settle), value: kind)
    }
}
