import CaretHostCore

/// Every word onboarding shows, in one place, so the copy can change without touching a view (HANDOFF §3; Sam has not
/// reviewed it yet). Third person, sentence case, no dashes as punctuation, no exclamation marks.
enum OnboardingCopy {
    enum Hello {
        static let title = "Caret works where you type."
        static let line = "It offers the next words, and sometimes the next step. Tab takes it. Typing says no."
        static let fieldLabel = "Try it. Start a sentence in your own words."
        static let placeholder = "Start a sentence"
        static let coachShown = "takes it. Typing says no."
        static let coachTaken = "That's it. That's most of Caret."
        static let loading = "Getting the writing model ready. The field wakes up when it's done."
        static let unavailable = "The writing model isn't on this Mac yet. Caret still turns on, and the next words start once it is."
        static func apps(_ list: String) -> String { "It'll be there in \(list)." }
        static let primary = "Turn on Caret"
        static let caption = "One switch in System Settings. Caret moves on by itself."
        static let later = "Set up later"
    }

    enum Access {
        static let title = "Drag Caret into the list."
        static let line = "System Settings is open at Privacy & Security, Accessibility. Drag Caret from here into the list there. macOS asks for your password or Touch ID."
        static let reopened = "Caret opened again, and it isn't on yet. Open System Settings, then drag Caret into the Accessibility list."
        static let row = "Accessibility"
        static let waiting = "Waiting for the switch…"
        static let on = "On."
        static let help = "Caret isn't in the list?"
        static let helpLine = "Click + under the list, choose Caret in Applications, then flip its switch."
        static let reopen = "Open System Settings again"
        static let landedTitle = "Caret is on."
        static let landedLine = "It can see where you type now. Nothing has left this Mac."
    }

    enum On {
        static let title = "Caret is on."
        static func nextWords(_ apps: String) -> String { "As you type, in \(apps). Tab takes them." }
        static let rows: [(title: String, state: String)] = [("Next words", "On"), ("Fixes", "On in Mac apps"), ("The next step", "Needs the cloud model")]
        static let fixesDetail = "A quiet underline under a slip or a broken sentence. Tab fixes it."
        static let fixesWeb = "Web pages soon"
        static let stepDetail = "A form from your notes, or a mail into Calendar. Shown first; written on Tab."
        static let stepSent = "On"
        static let stepKept = "Off"
        static let stepKeptDetail = "Turn it on in the menu bar"
        static let consentHead = "Before anything leaves this Mac"
        static func consentLine(chars: Int, windows: Int) -> String {
            "Caret would send at most these \(chars) characters from \(windows) window\(windows == 1 ? "" : "s") to Jev, its cloud model, and nothing else. Banded lines may go, hatched lines stay. Nothing goes until you say so."
        }
        static let building = "Reading what's open…"
        static let empty = "Nothing on screen right now needs the cloud model. The next step stays off until you turn it on in the menu bar."
        static let failed = "Caret couldn't read what's open just now. The next step stays off until you turn it on in the menu bar."
        static let keptHead = "Kept on this Mac"
        static let kept = "Next words still work. The next step stays off until you turn it on in the menu bar."
        static let looking = "Sent. Looking for a next step in what's open…"
        static let keyLabel = "Key"
        static let keyPlaceholder = "Paste your Jev key"
        static let keyNote = "For now the cloud model needs a key. Caret keeps it in your login keychain and checks it with one small request."
        static let promiseLabel = "The privacy promise"
        static let send = "Send these and look"
        static let keep = "Keep everything on this Mac"
        static let done = "Done"
    }

    enum First {
        static let title = "Caret found a next step."
        static func lead(app: String, title: String) -> String { "In \(app), \(title)." }
        static let trust = "Before it acts inside another app, Caret asks. Say yes a few times and it stops asking for that app."
        static let soon = "Soon"
        static let undo = "⌘Z takes back anything it wrote."
        static let asking = "macOS asks once for Calendar. Caret adds only the events you take."
        static let denied = "Calendar access is off, so Caret left it. Allow Caret under Privacy & Security, Calendars."
        static let doneHint = "That's the shape of it. Caret shows the step and where it came from, then writes it when you press Tab."
        static let declinedTitle = "Left alone."
        static let declinedHint = "Caret offers again when a mail like this is open."
        static let nothingTitle = "Nothing to do yet."
        static let nothing = "Caret looked at what's open and found no form to fill and no mail to turn into an event. When there is one, it shows up where you type."
        static let menuBar = "Caret lives in the menu bar. Pause it or change anything there."
        static let notNow = "Not now"
        static let done = "Done"
    }

    /// The panel inside System Settings' Accessibility pane.
    enum Drag {
        static let header = "Drag Caret into the list above"
        static let voiceOver = "Drag Caret to System Settings, or press to show it in Finder"
        static let close = "Close"
    }

    /// The one-time coach slip at the first ghost text in another app.
    enum Coach {
        static let lead = "First time:"
        static let takes = "takes it"
        static let no = "Typing says no"
    }

    /// Keys and their words for a found offer's hint line, as the design draws them.
    static func hint(for found: FirstLookReply.Found) -> [(key: String, words: String)] {
        switch found.kind {
        case .fill: return [("Tab", "fills them."), ("Esc", "leaves them."), ("⌘Z", "takes them back.")]
        case .action, .report: return [("Tab", "adds it."), ("Esc", "leaves it alone."), ("⌘Z", "takes it back out.")]
        }
    }
}
