import CaretScreenCore
import Foundation

/// What an offer shows when its panel has no clear spot around the field (brief A13, part 3).
///
/// A12's on-screen runs on a 1440 by 900 screen found tight forms where every spot for a pop-up
/// covered one of the app's own fields or labels, and `FieldPanelPlacement` then took the spot
/// covering least. A panel must never cover a label, so the offer falls back to the compact offer
/// line: 20 pt tall with 11 pt type, the size `LinePlacement` already uses for a fill's line in a
/// tight gap, placed by the offer line's rule (below the caret's line, else above, else beside the
/// field). It names the offer and its keys, and ↓ opens the full card. When even the compact line
/// covers something, the offer is held (`SurfaceGate.Hold.noClearSpot`) rather than drawn.
public enum CompactOffer {
    /// The hint that says ↓ opens the full card.
    public static let moreHint = Hint(key: "↓", label: "More")

    /// An action line, compact: the same words and keys; ↓ is named when it opens variants.
    public static func line(_ action: ActionLine) -> LineContent {
        var hints = Hint.hints(action.actions)
        if action.variants != nil { hints.append(moreHint) }
        return LineContent(figure: .offering, app: action.app, text: action.endState.text, hints: hints)
    }

    /// A pop-up, compact: its title, and for a picker the row Tab would take, so Tab never takes
    /// something the line does not show. Tab is labelled, since the title alone does not say what
    /// it does ("Coffee with Dana  Tab Add to calendar  ↓ More").
    public static func line(_ spec: PopupSpec, highlight: Int?) -> LineContent {
        var text = spec.header?.title.text ?? ""
        if let choices = spec.choices, !choices.rows.isEmpty {
            let row = min(max(highlight ?? choices.selected, 0), choices.rows.count - 1)
            let label = choices.rows[row].label.text
            text = text.isEmpty ? label : "\(text) \(label)"
        }
        var hints: [Hint] = []
        if let tab = spec.actions.first(where: { $0.key == .tab }) { hints.append(Hint(key: Hint.key(.tab), label: tab.label)) }
        hints.append(moreHint)
        return LineContent(figure: spec.figure == .needsYou ? .needsYou : .offering, text: text, hints: hints)
    }
}
