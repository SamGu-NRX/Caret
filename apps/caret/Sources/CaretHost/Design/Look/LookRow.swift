import CaretHostCore
import SwiftUI

/// One row of the page panel, v41's grammar (DIRECTION 2, v4 3.8): mark · label · value · owner. The owner column names
/// the source; a run of rows from one source shares a bracket. A blank row draws a hatch (yours on purpose) or a dotted
/// blank (found nothing) where the value would go. While a row is written a Carrot rule draws under its value.
struct LookRow: View {
    var line: PageTaskPanel.Line
    /// The row's place in the panel, for the stagger.
    var index: Int

    @Environment(\.lookMotion) private var motion
    @Environment(\.lookFocus) private var focus
    @Environment(\.lookStagger) private var stagger
    @State private var arrived = false

    var body: some View {
        HStack(alignment: .center, spacing: LookShape.gap) {
            if line.kind == .withheld || line.kind == .yours {
                sentence
            } else {
                LookRowMark(state: line.kind == .blank ? nil : (line.state ?? .pending), shows: line.kind == .field || line.kind == .step)
                    .frame(width: LookShape.markColumn, height: 14)
                if line.kind == .step {
                    LookValue(line: line)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(line.label ?? "")
                        .foregroundStyle(Color(token: CaretColor.ink2))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(width: LookShape.labelColumn, alignment: .leading)
                    Group {
                        if let blank = line.blank { LookBlank(blank: blank) } else { LookValue(line: line) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                LookOwner(line: line)
            }
        }
        .font(LookFont.row)
        .frame(minHeight: LookShape.rowHeight)
        .padding(.horizontal, 2)
        .overlay(alignment: .trailing) { LookRowBracket(run: line.run) }
        .background {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color(token: CaretColor.focusRow))
                .opacity(focus != nil && focus == line.key ? 1 : 0)
        }
        .background {
            GeometryReader { g in
                Color.clear.preference(key: LookGeometryKey.self, value: LookGeometry(rows: line.key.map { [$0: g.frame(in: .named(LookSpace.group))] } ?? [:]))
            }
        }
        // A panel's first rows arrive 30 ms apart, capped at the sixth (v41 5.2 `stagger`); opacity only.
        .opacity(stagger && !arrived ? 0 : 1)
        .onAppear {
            guard stagger else { return }
            // Every row ends visible: staggered when the motion has a stagger, else together (Reduce Motion: one fade;
            // a key: at once). Prep-for-prod L1-B1: under Reduce Motion the rows stayed transparent.
            if let step = motion.stagger {
                withAnimation(CaretMotion.out(160)?.delay(Double(min(index, PageTaskLook.staggerCap)) * step / 1000)) { arrived = true }
            } else {
                withAnimation(CaretMotion.fade(motion.appear)) { arrived = true }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.spoken)
        .modifier(RowVoiceFocus(key: line.key))
    }

    private var sentence: some View {
        Text(line.text)
            .font(line.kind == .yours ? LookFont.row.weight(.medium) : LookFont.meta)
            .foregroundStyle(Color(token: line.kind == .yours ? CaretColor.ink : CaretColor.ink2))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, LookShape.markColumn + LookShape.gap)
            .padding(.vertical, 3)
    }
}

/// VoiceOver on a row shows its crop, as the pointer does. Only the live panel tracks it (`lookVoiceFocus` set);
/// off-screen renders draw rows without the focus state.
private struct RowVoiceFocus: ViewModifier {
    var key: Int?
    @Environment(\.lookVoiceFocus) private var voiceFocus
    @Environment(\.lookTracksVoiceOver) private var tracks
    @AccessibilityFocusState private var on: Bool

    func body(content: Content) -> some View {
        if tracks, let key {
            content
                .accessibilityFocused($on)
                .onChange(of: on) { _, now in voiceFocus(key, now) }
        } else {
            content
        }
    }
}

/// The value: Ink, whole (it wraps to a second line rather than cutting a date or a name), a small ▾ when it was picked
/// from the page's own list, and the writing rule under it.
private struct LookValue: View {
    var line: PageTaskPanel.Line
    @Environment(\.lookMotion) private var motion

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            // The ▾ is part of the text, so it follows the value's last word when the value wraps.
            (Text(Self.breakable(line.text)).foregroundColor(Color(token: line.state == .failed || line.state == .already ? CaretColor.ink2 : CaretColor.ink))
                + (line.picked ? Text(" ▾").font(.system(size: 10)).foregroundColor(Color(token: CaretColor.ink3)) : Text("")))
                .lineLimit(line.wraps ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .overlay(alignment: .bottomLeading) {
                    ZStack {
                        if line.state == .writing { LookWriteRule(rule: motion.rule).transition(.opacity) }
                    }
                    .offset(y: 2)
                    .animation(CaretMotion.fade(motion.settle), value: line.state)
                }
        }
    }
}

extension LookValue {
    /// A long value with no spaces (an address, a link) may break after "@" or "/" rather than mid-word, so a wrapped
    /// email reads "ines.vandermeer@ / example.org". Zero-width spaces: nothing visible, nothing VoiceOver reads.
    static func breakable(_ s: String) -> String {
        guard s.count > 18, !s.contains(" ") else { return s }
        var out = ""
        for c in s {
            out.append(c)
            if c == "@" || c == "/" { out.append("\u{200B}") }
        }
        return out
    }
}

/// v41's writing rule: 1.5 pt Carrot, drawn left to right on the row's clock (`write`, 320 ms `out`), whole when a key
/// caused the change, absent under Reduce Motion. The crop's span uses the same view, so both start in one frame.
struct LookWriteRule: View {
    var rule: PageTaskLook.Rule
    @State private var drawn = false

    var body: some View {
        switch rule {
        case .none:
            EmptyView()
        case .whole:
            Rectangle().fill(Color(token: CaretColor.carrot)).frame(height: 1.5)
        case .draws(let ms):
            Rectangle().fill(Color(token: CaretColor.carrot)).frame(height: 1.5)
                .scaleEffect(x: drawn ? 1 : 0, anchor: .leading)
                .onAppear { withAnimation(CaretMotion.out(ms)) { drawn = true } }
        }
    }
}

/// ring (to do) · Carrot dot (writing) · check (written; Ink 3 when it was already so) · dash (the light went out here).
/// A blank row has no mark.
struct LookRowMark: View {
    var state: PageTask.Row.State?
    var shows: Bool
    @Environment(\.lookMotion) private var motion

    var body: some View {
        ZStack {
            if shows, let state {
                switch state {
                case .pending:
                    Circle().strokeBorder(Color(token: CaretColor.ink3), lineWidth: 1).frame(width: 5, height: 5)
                case .writing:
                    Circle().fill(Color(token: CaretColor.carrot)).frame(width: 5, height: 5)
                case .verified:
                    Check().stroke(Color(token: CaretColor.ink2), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).frame(width: 8, height: 8)
                        .transition(.opacity)
                case .already:
                    Check().stroke(Color(token: CaretColor.ink3), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).frame(width: 8, height: 8)
                case .failed:
                    RoundedRectangle(cornerRadius: 1).fill(Color(token: CaretColor.graphite)).frame(width: 7, height: 1.5)
                }
            }
        }
        .animation(CaretMotion.fade(motion.settle), value: state)
        .accessibilityHidden(true)
    }
}

/// A short check, as v4's 3 × 7 rotated L.
private struct Check: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + rect.width * 0.12, y: rect.minY + rect.height * 0.55))
        p.addLine(to: CGPoint(x: rect.minX + rect.width * 0.4, y: rect.maxY - rect.height * 0.12))
        p.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.08, y: rect.minY + rect.height * 0.12))
        return p
    }
}

/// The two blanks (v41 2.1, 4): a hatch, 1 pt lines every 4 pt at 135° in Ink at 30%, means yours on purpose; a dotted
/// Ink 3 line of 2 pt dots means Caret found nothing. Up to 150 wide.
struct LookBlank: View {
    var blank: PageTaskPanel.Line.Blank
    var height: CGFloat = 11
    /// 150 in a row; the crop's paper is the whole width.
    var maxWidth: CGFloat = 150

    var body: some View {
        Group {
            switch blank {
            case .hatch:
                Hatch()
                    .stroke(Color(token: CaretColor.hatch), lineWidth: 1)
                    .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 2, style: .continuous).strokeBorder(Color(token: CaretColor.hatch), lineWidth: 0.5) }
                    .frame(height: height)
            case .dotted:
                DottedLine()
                    .stroke(Color(token: CaretColor.ink3), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.01, 3.5]))
                    .frame(height: 2)
                    .frame(height: height + 1, alignment: .bottom)
            }
        }
        .frame(maxWidth: maxWidth)
        .accessibilityHidden(true)
    }
}

/// The bracket's piece for a row in a run, at the row's trailing edge over its whole height.
struct LookRowBracket: View {
    var run: PageTaskPanel.Line.Run?

    var body: some View {
        if let run, run != .single { Bracket(run: run).frame(width: 4).padding(.trailing, 3) }
    }
}

/// A line across the middle, for the dotted blank's round dots.
private struct DottedLine: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.minX + 1, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}

/// Diagonal lines every 4 pt at 135°.
private struct Hatch: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX + rect.height {
            p.move(to: CGPoint(x: x, y: rect.maxY))
            p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            x += 4
        }
        return p
    }
}

/// The owner column: the source's word on a run's first row (and a row alone), "already so", a blank's "yours to
/// write"; and for a run of two or more, the bracket: 1 pt Ink 3, 10 pt right of the word, with 4 pt ticks at the run's
/// first and last rows (v41 2.4).
private struct LookOwner: View {
    var line: PageTaskPanel.Line

    var body: some View {
        let bracketed = line.run != nil && line.run != .single
        Text(line.showsOwner ? (line.owner ?? "") : "")
            .font(LookFont.meta)
            .foregroundStyle(Color(token: line.state == .failed ? CaretColor.graphite : CaretColor.ink2))
            .lineLimit(1)
            .fixedSize()
            .padding(.trailing, bracketed ? 10 : 0)
            .frame(minWidth: bracketed ? 12 : 0, alignment: .trailing)
    }
}

/// One row's piece of a run's bracket.
private struct Bracket: View {
    var run: PageTaskPanel.Line.Run

    var body: some View {
        Canvas { context, size in
            let x = size.width - 0.5
            let mid = size.height / 2
            var p = Path()
            switch run {
            case .first:
                p.move(to: CGPoint(x: 0, y: mid)); p.addLine(to: CGPoint(x: x, y: mid)); p.addLine(to: CGPoint(x: x, y: size.height))
            case .middle:
                p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: size.height))
            case .last:
                p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: mid)); p.addLine(to: CGPoint(x: 0, y: mid))
            case .single:
                break
            }
            context.stroke(p, with: .color(Color(token: CaretColor.ink3)), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}
