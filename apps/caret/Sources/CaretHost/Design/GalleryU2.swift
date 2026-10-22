import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// v3 part 2 renders not covered by the desk, rim, knows and onboarding galleries: the slip and the
// pop-up with where a noticed fact came from and "Not right", the desk's card with it, and the menu
// bar glyph at rest and lit. Synthetic content only.
extension Gallery {
    static let noticedSays = "from what Caret noticed in Mail Fixture, Tue"

    static func row(_ phase: NotRightRow.Phase, text: String = "", correctable: Bool = true, problem: String? = nil) -> NotRightRow {
        NotRightRow(says: noticedSays, more: 0, correctable: correctable, phase: phase, text: text, problem: problem)
    }

    /// The offer line for a guest field filled from a noticed fact.
    static let guestLine = LineContent(figure: .offering, app: "Mail", text: "Guest: Marcus Lowe (ops)", hints: [Hint(key: "Tab")])

    static func provenance(_ character: FigureCharacter = .pebble) -> [Item] {
        func slip(_ row: NotRightRow, interactive: Bool = false) -> AnyView {
            AnyView(LineView(content: guestLine, character: character, animated: false,
                             under: AnyView(NotRightRowView(row: row, indent: LineView.textIndent(compact: false))), underInteractive: interactive))
        }
        let card = PopupView(spec: eventCard, character: character, animated: false,
                             under: AnyView(NotRightRowView(row: row(.shown), indent: 12 + PopupView.indent)))
        return [
            Item(name: "slip-provenance", view: slip(row(.shown))),
            Item(name: "slip-not-right", view: slip(row(.correcting, text: "Marcus Lowe, Ops lead"), interactive: true)),
            Item(name: "slip-not-right-preference", view: slip(row(.correcting, correctable: false), interactive: true)),
            Item(name: "slip-not-right-done", view: slip(row(.answered(NotRightRow.forgotten)))),
            Item(name: "popup-provenance", view: AnyView(card)),
        ]
    }

    /// The desk with a plan built from a noticed fact: the row on the card, then the correction open.
    static func deskProvenance(_ character: FigureCharacter = .pebble) -> [Item] {
        func desk(_ row: NotRightRow) -> AnyView {
            let section = AskSection(text: askInstruction, phase: .proposed(askCard), character: character, showsFocus: false, animated: false, notRight: row)
            return AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(section), askActive: true, askHeader: .waiting)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        return [
            Item(name: "desk-provenance", view: desk(row(.shown))),
            Item(name: "desk-not-right", view: desk(row(.correcting, text: "ORD-2026-48231"))),
        ]
    }

    /// The menu bar glyph (5.10): the figure's silhouette with the eyes cut out, a template at rest
    /// (the menu bar's own color, so it follows a light or dark bar) and Carrot while work runs or
    /// waits on the user.
    static func glyph(_ character: FigureCharacter = .pebble) -> [Item] {
        [
            Item(name: "menu-glyph", view: AnyView(GlyphPair(character: character))),
        ]
    }
}

/// The glyph at rest and lit, side by side on a menu bar in the render's appearance.
private struct GlyphPair: View {
    var character: FigureCharacter
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            // The strip is as wide as the rim scene, its glyph and clock pushed to the right end; a
            // centered 220 pt window showed only the empty middle of the bar, so the reference was
            // blank and guarded nothing. Trailing keeps the glyph and the clock in view.
            RimScene.MenuBarStrip(lit: false, character: character, dark: scheme == .dark).frame(width: 220, alignment: .trailing).clipped()
            RimScene.MenuBarStrip(lit: true, character: character, dark: scheme == .dark).frame(width: 220, alignment: .trailing).clipped()
        }
    }
}
