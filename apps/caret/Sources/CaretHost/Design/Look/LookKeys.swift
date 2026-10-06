import CaretHostCore
import SwiftUI

/// v41's keycap (v4 BUILD-FIRST "Keycap"): 17 tall, radius 4, 11 pt Medium in Ink, a 1 pt edge and a 1.5 pt bottom edge,
/// so it reads as a key and not a tag.
struct LookKeycap: View {
    var key: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)
        Text(key)
            .font(LookFont.key)
            .monospacedDigit()
            .foregroundStyle(Color(token: CaretColor.ink))
            .padding(.horizontal, 5)
            .frame(height: 17)
            .background(shape.fill(Color(token: CaretColor.keyBG)))
            .overlay { shape.strokeBorder(Color(token: CaretColor.keyEdge), lineWidth: 1) }
            .overlay(alignment: .bottom) {
                Color(token: CaretColor.keyEdge).frame(height: 0.5).padding(.horizontal, 1)
            }
    }
}

/// A key and what it does: `Tab Fill 11`. The label in Ink 2 at 12 pt.
struct LookHint: View {
    var hint: Hint

    var body: some View {
        HStack(spacing: 4) {
            LookKeycap(key: hint.key)
            if let label = hint.label {
                Text(label).font(.system(size: 12)).foregroundStyle(Color(token: CaretColor.ink2))
            }
        }
        .fixedSize()
    }
}
