import CaretHostCore
import SwiftUI

// H13's states: inline text in a web field (a textarea on a light page, the same on a dark page), the quiet line in
// Gmail's compose body, and the line about a Google Doc whose text is off. Synthetic content only.

extension Gallery {
    /// A web page's textarea with the user's text and Caret's inline text after the caret, drawn as the coordinator
    /// draws it (`PageGhostText`). The page follows the render's theme here, so both inks are seen: a light page in
    /// the light render, a dark page in the dark one.
    struct PageFieldScene: View {
        let typed: String
        let ghost: String
        var ghostHidden = false
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            let dark = scheme == .dark
            VStack(alignment: .leading, spacing: 6) {
                Text("Cover letter")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(nsColor: Tokens.srgb(dark ? 0xE6E6EA : 0x1F2328)))
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(typed)
                        .font(.system(size: 15))
                        .foregroundStyle(Color(nsColor: Tokens.srgb(dark ? 0xE6E6EA : 0x1F2328)))
                    PageGhostText(text: ghost, size: 15, darkField: dark, hidden: ghostHidden)
                }
                .padding(12)
                .frame(width: 520, height: 96, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: Tokens.srgb(dark ? 0x26262C : 0xFFFFFF))))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: Tokens.srgb(dark ? 0x4A4D55 : 0x8C959F)), lineWidth: 1))
            }
            .padding(16)
            .background(Color(nsColor: Tokens.srgb(dark ? 0x1F1F24 : 0xF6F8FA)))
        }
    }

    static let h13Typed = "I am writing to apply for the"
    static let h13Ghost = " Field Robotics Technician role"

    static func h13(_ character: FigureCharacter = .pebble) -> [Item] {
        [
            Item(name: "page-inline-ghost", view: AnyView(PageFieldScene(typed: h13Typed, ghost: h13Ghost))),
            Item(name: "page-inline-gmail", view: AnyView(PageInlineNoticeView(content: PageInlineCopy.notice(.gmail), character: character))),
            Item(name: "page-inline-docs-off", view: AnyView(PageInlineNoticeView(
                content: PageInlineCopy.sourceOff("Google Docs", says: "Turn on screen reader and braille support in Google Docs, ⌘⌥Z then ⌘⌥H, so Caret can read it."),
                character: character
            ))),
        ]
    }
}
