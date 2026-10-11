import CaretHostCore
import SwiftUI

/// H13: inline text in a page field, as `PageInlineCoordinator` draws it and the gallery renders it. The page's font is
/// unknown to the host, so it is the system font at the field's size (`PageField.Look.fontSize`), in the page's own
/// ink at ghost opacity (`Tokens.ghostOpacity`): black on a light field, white on a dark one (`Look.dark`), whatever
/// Caret's theme.
struct PageGhostText: View {
    let text: String
    let size: CGFloat
    /// The field shows light text on a dark ground.
    let darkField: Bool
    var hidden = false

    var body: some View {
        Text(text)
            .font(.system(size: size))
            .foregroundStyle(Color(nsColor: darkField ? .white : .black).opacity(hidden ? 0 : Tokens.ghostOpacity(dark: darkField)))
            .fixedSize()
            .accessibilityHidden(true)
    }
}

/// H13: the quiet line at a page field, about its own suggestions or a source Caret cannot read: one short sentence on
/// the line and the longer one, with the keys, in the row under it that wraps (`LineView`'s question row).
struct PageInlineNoticeView: View {
    let content: LineContent
    let character: FigureCharacter
    var animated = false

    var body: some View {
        LineView(content: content, character: character, animated: animated)
    }
}
