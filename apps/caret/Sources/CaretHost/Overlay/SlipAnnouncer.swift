import AppKit
import CaretHostCore
import SwiftUI

/// Posts what VoiceOver says for a slip (`SlipSpeech`). A slip never takes focus, so its words
/// are announced rather than read on focus: on entrance and on each change of state.
@MainActor
enum SlipAnnouncer {
    /// The words to post, or nil when they are what was last said.
    static func next(_ words: String, last: String?) -> String? {
        SlipSpeech.announcement(next: words, last: last)
    }

    static func post(_ words: String) {
        AccessibilityNotification.Announcement(words).post()
    }
}
