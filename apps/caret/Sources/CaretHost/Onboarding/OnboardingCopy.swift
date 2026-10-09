import CaretHostCore
import Foundation

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
        /// The model is released while the words role is off (`ModelNeed`), so "isn't on this Mac" would be untrue.
        static let wordsOff = "Complete words is off, so this field stays quiet. Turn it on under Help With in Caret's menu to try it."
        static func apps(_ list: String) -> String { "It'll be there in \(list)." }
        static let primary = "Turn on Caret"
        static let caption = "One switch in System Settings. Caret moves on by itself."
        static let later = "Set up later"
    }

    enum Access {
        static let title = "Drag Caret into the list."
        /// The list's name on this Mac: "Accessibility", or "Device Control and Data Access" from macOS 27.
        static var pane: String { AccessibilityAccess.paneName(osMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion) }
        static var line: String {
            "System Settings is open at Privacy & Security, \(pane). Turn on Caret there, or drag it in from here. macOS asks for your password or Touch ID."
        }
        static var reopened: String {
            "Caret opened again, and it isn't on yet. Open System Settings, then turn on Caret in the \(pane) list."
        }
        static let staleTitle = "Caret was updated."
        static var staleLine: String {
            "macOS still shows Caret's switch, but it no longer applies to this version. Reset Caret's entry, then add Caret to the \(pane) list again."
        }
        static let reset = "Reset Caret's entry"
        /// This running copy, as System Settings and Finder show it: "Caret.app in /Applications".
        static var thisCaret: String { OtherCaret(bundleID: "", path: Bundle.main.bundlePath).place }
        static func several(_ others: [OtherCaret]) -> String {
            "There's more than one Caret on this Mac. Turn on the one that's open now, \(thisCaret), not \(others.map(\.place).joined(separator: " or "))."
        }
        static let wrongTitle = "A different Caret was turned on."
        static func wrongLine(_ others: [OtherCaret]) -> String {
            "The switch you turned on belongs to \(others.map(\.place).joined(separator: " or ")). This Caret is \(thisCaret): drag it into the list, or turn on the entry for it. Moving the other Caret to the Trash avoids the mix-up."
        }
        static var row: String { pane }
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
        /// `apps` is HelloApps.list of the apps found; with none found, the line names no app rather than an empty one.
        static func nextWords(_ apps: String) -> String {
            apps.isEmpty ? "As you type, in any app. Tab takes them." : "As you type, in \(apps). Tab takes them."
        }
        static let fixesDetail = "A quiet underline under a slip or a broken sentence. Tab fixes it."
        /// Where fixes run, from what this build has: Mac apps always, web pages when it has the page writing path
        /// (`PageWritingMachine.webFields`).
        static func fixesState(webPages: Bool) -> String { webPages ? "On in Mac apps\nand web pages" : "On in Mac apps" }
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
        /// Only what is built: asking before acting, and ⌘Z. Learning when to stop asking is EarnedTrust, a hook with no
        /// behavior yet, so the line promises none (coordinator's copy, 2026-10-09).
        static let trust = "Before it acts inside another app, Caret asks. ⌘Z takes back anything it wrote."
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

    enum Browser {
        static let title = "Add Caret to your browser."
        static func line(_ names: String) -> String {
            "In \(names), Caret reads and fills web pages through a small extension. It's optional: Caret already works in your apps."
        }
        static let none = "Caret's extension works in Google Chrome and Helium, and neither is on this Mac. Caret already works in your apps; add the extension later from the menu bar."
        static let waiting = "Waiting for Caret for Chrome to connect…"
        static func connected(_ name: String) -> String { "Caret is in \(name)." }
        static func add(_ name: String) -> String { "Add to \(name)" }
        static func untrusted(_ name: String) -> String { "Caret can't connect to \(name) yet." }
        static let stepsHead = "In the Extensions page:"
        /// What Skip costs, said before the person chooses (AltTab states each optional permission's cost).
        static func cost(_ name: String) -> String { "Without it, Caret can't read or fill web pages in \(name). You can add it later from the menu bar." }
        static let skip = "Skip"
        static let next = "Continue"
    }

    /// The panel inside System Settings' Accessibility pane.
    enum Drag {
        static let header = "Turn on Caret in the list above. Not there? Drag it in."
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
