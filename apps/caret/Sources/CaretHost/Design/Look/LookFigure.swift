import CaretHostCore
import SwiftUI

/// The mark beside the page panel's title, behind one token (`PageTaskLook.figure`). Sam has not chosen; the L1 gallery
/// renders every option.
struct LookFigure: View {
    var option: PageTaskLook.Figure
    var character: FigureCharacter
    var state: FigureState

    var body: some View {
        switch option {
        case .today:
            // Still: v41's vocabulary has no loop (DIRECTION 5.2: the 4 s breath sat in the slow-oscillation band), so the
            // page panel draws today's character without its breath, blink or glow.
            FigureView(character: character, state: state, facing: .right, size: PopupView.figureSize, animated: false)
        case .v4Caret:
            V4Caret(lightOut: state == .error || state == .still)
                .frame(width: LookShape.figure, height: LookShape.figure * 13 / 12)
        case .proofreader:
            ProofMark()
                .fill(Color(token: state == .error ? CaretColor.graphite : CaretColor.carrot))
                .frame(width: LookShape.figure, height: LookShape.figure * 13 / 12)
        case .none:
            EmptyView()
        }
    }

    /// The title's leading inset: the figure's slot, or none.
    static func slot(_ option: PageTaskLook.Figure) -> CGFloat? {
        switch option {
        case .today: return PopupView.figureSlot
        case .v4Caret, .proofreader: return LookShape.figure
        case .none: return nil
        }
    }
}

/// v4's figure: a flat Carrot caret with eyes (design/v4 DIRECTION 3.5), viewBox 12 × 13; Graphite when the light is out.
private struct V4Caret: View {
    var lightOut: Bool

    var body: some View {
        GeometryReader { g in
            let s = g.size.width / 12
            ZStack(alignment: .topLeading) {
                Drop().fill(Color(token: lightOut ? CaretColor.graphite : CaretColor.carrot))
                ForEach([4.25, 7.75], id: \.self) { x in
                    Circle().fill(Color(nsColor: Tokens.eye))
                        .frame(width: 1.9 * s, height: 1.9 * s)
                        .position(x: x * s, y: 8.35 * s)
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// `M6 .9 C7.7 3.2 10.7 5.6 10.7 8.4 A4.7 4.3 0 0 1 1.3 8.4 C1.3 5.6 4.3 3.2 6 .9 Z`, the arc as two quarter-ellipse cubics.
private struct Drop: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 12
        let k = 0.5523
        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(6, 0.9))
        path.addCurve(to: p(10.7, 8.4), control1: p(7.7, 3.2), control2: p(10.7, 5.6))
        path.addCurve(to: p(6, 12.7), control1: p(10.7, 8.4 + 4.3 * k), control2: p(6 + 4.7 * k, 12.7))
        path.addCurve(to: p(1.3, 8.4), control1: p(6 - 4.7 * k, 12.7), control2: p(1.3, 8.4 + 4.3 * k))
        path.addCurve(to: p(6, 0.9), control1: p(1.3, 5.6), control2: p(4.3, 3.2))
        path.closeSubpath()
        return path
    }
}

/// v41's proofreader's caret, a pen-weighted ‸ (prototype scenes.js MARK_PATH), viewBox 12 × 13.
struct ProofMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 12
        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(5.3, 1.5))
        path.addCurve(to: p(6.7, 1.5), control1: p(5.6, 1), control2: p(6.4, 1))
        path.addCurve(to: p(11, 10.9), control1: p(8.4, 4.6), control2: p(9.9, 8))
        path.addCurve(to: p(10.1, 11.5), control1: p(11.2, 11.5), control2: p(10.6, 11.9))
        path.addCurve(to: p(6.1, 3.7), control1: p(8.8, 9), control2: p(7.3, 5.8))
        path.addCurve(to: p(2.4, 11.3), control1: p(4.9, 5.8), control2: p(3.6, 8.6))
        path.addCurve(to: p(1.6, 11.1), control1: p(2.2, 11.8), control2: p(1.5, 11.7))
        path.addCurve(to: p(5.3, 1.5), control1: p(2.9, 7.9), control2: p(4.3, 4))
        path.closeSubpath()
        return path
    }
}
