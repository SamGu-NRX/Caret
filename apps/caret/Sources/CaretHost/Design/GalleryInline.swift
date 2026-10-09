import CaretHostCore
import SwiftUI

/// The Writing tab's states (brief items 4, 6 and 7), for `InlineRenderTests` and review. Synthetic words only.
extension Gallery {
    static func inline(_ character: FigureCharacter = .pebble) -> [Item] {
        func tab(_ w: WritingPage.State) -> AnyView {
            AnyView(MemoryView(state: memoryState(), files: memoryFiles(), tab: .writing, character: character, writing: w, animated: false, now: memoryNow)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        var empty = WritingPage.State()
        empty.hereApp = WritingPage.App(bundleID: "com.tinyspeck.slackmacgap", name: "Slack")

        var filled = empty
        filled.aboutDraft = "I'm a student building a writing tool. I write short, plain sentences and sign emails with my first name."
        filled.aboutSaved = filled.aboutDraft
        filled.herePage = "https://mail.google.com"
        filled.entries = [WritingPage.Entry(kind: .app, key: "com.apple.mail", name: "Mail", text: "Formal, full sentences, no exclamation marks.")]
        filled.editing = ("site:https://mail.google.com", "Replies are short and end with a clear next step.")

        var keys = filled
        keys.editing = nil
        keys.keys = .cotypist
        keys.appsOff = [WritingPage.App(bundleID: "com.apple.Terminal", name: "Terminal")]

        return [
            Item(name: "writing-empty", view: tab(empty)),
            Item(name: "writing-editing", view: tab(filled)),
            Item(name: "writing-cotypist-keys", view: AnyView(tab(keys).environment(\.offscreenScrolledToEnd, true))),
        ]
    }
}
