import Foundation

/// What Caret knows' Writing tab: personal instructions (brief item 4), the accept keys (item 6) and the apps Caret is
/// off in (item 7). Pure state and copy; `MemoryController` owns it and `MemoryView` draws it. The instruction text in
/// it never goes to the debug socket (`debugInfo`).
public enum WritingPage {
    public struct App: Equatable, Sendable, Identifiable {
        public var bundleID: String
        public var name: String
        public var id: String { bundleID }
        public init(bundleID: String, name: String) { self.bundleID = bundleID; self.name = name }
    }

    /// Instructions for one app or one site.
    public struct Entry: Equatable, Sendable, Identifiable {
        public enum Kind: String, Sendable { case app, site }
        public var kind: Kind
        /// The bundle identifier or the origin.
        public var key: String
        public var name: String
        public var text: String
        public var id: String { "\(kind.rawValue):\(key)" }
        public init(kind: Kind, key: String, name: String, text: String) { self.kind = kind; self.key = key; self.name = name; self.text = text }
    }

    public struct State: Equatable, Sendable {
        public var keys = GhostKeys.caret
        /// The About you editor's text, and the saved text it started from.
        public var aboutDraft = ""
        public var aboutSaved = ""
        public var entries: [Entry] = []
        /// The entry being edited (by id, possibly not yet saved) and its text.
        public var editing: (id: String, draft: String)?
        /// The app and the page the user was in when the window opened.
        public var hereApp: App?
        public var herePage: String?
        public var appsOff: [App] = []
        /// A line under the About you editor: an import that found nothing.
        public var problem: String?

        public init() {}

        public static func == (a: State, b: State) -> Bool {
            a.keys == b.keys && a.aboutDraft == b.aboutDraft && a.aboutSaved == b.aboutSaved && a.entries == b.entries
                && a.editing?.id == b.editing?.id && a.editing?.draft == b.editing?.draft && a.hereApp == b.hereApp
                && a.herePage == b.herePage && a.appsOff == b.appsOff && a.problem == b.problem
        }

        public var aboutChanged: Bool { aboutDraft != aboutSaved }

        /// "Add for …" for the app or page the user was in, when it has no entry yet.
        public var addable: [Entry] {
            var out: [Entry] = []
            if let page = herePage, !entries.contains(where: { $0.kind == .site && $0.key == page }) {
                out.append(Entry(kind: .site, key: page, name: SiteOrigin.display(page), text: ""))
            }
            if let app = hereApp, !entries.contains(where: { $0.kind == .app && $0.key == app.bundleID }) {
                out.append(Entry(kind: .app, key: app.bundleID, name: app.name, text: ""))
            }
            return out
        }
    }

    /// The entries in the settings, sites first, each sorted by name. `name` gives an app's display name.
    public static func entries(_ i: PersonalInstructions, name: (String) -> String) -> [Entry] {
        let sites = i.sites.map { Entry(kind: .site, key: $0.key, name: SiteOrigin.display($0.key), text: $0.value) }
        let apps = i.apps.map { Entry(kind: .app, key: $0.key, name: name($0.key), text: $0.value) }
        return sites.sorted { $0.name < $1.name } + apps.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The count under About you: how much of it reaches the model with nothing else beside it.
    public static func count(_ text: String) -> String {
        let n = PersonalInstructions.kept(text)?.count ?? 0
        let limit = PersonalInstructions.promptCharacters
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        let total = f.string(from: NSNumber(value: limit)) ?? "\(limit)"
        return n > limit
            ? "The model reads the first \(total) characters; the rest is kept here."
            : "\(f.string(from: NSNumber(value: n)) ?? "\(n)") of \(total) characters"
    }
}

/// The Writing tab's words.
public enum WritingPageCopy {
    public static let tab = "Writing"
    public static let aboutHead = "About you"
    public static let aboutIntro = "Caret's suggestions follow this in every app. Only the model on this Mac reads it."
    public static let aboutPlaceholder = "Who you are and how you write. For example: I'm a student. I write short, plain sentences."
    public static let importCotypist = "Import from Cotypist"
    public static let nothingToImport = "Cotypist has no instructions to import."
    public static let save = "Save"
    public static let entriesHead = "In one app or site"
    public static let entriesIntro = "Used with About you when you write there."
    public static let entriesEmpty = "None yet. Add some for the app or page you were in."
    public static func add(_ name: String) -> String { "Add for \(name)" }
    public static let edit = "Edit"
    public static let remove = "Remove"
    public static let cancel = "Cancel"
    public static let keysHead = "Accept keys"
    public static let offHead = "Caret is off in"
    public static let offEmpty = "Caret works in every app."
    public static let hereApp = "The app you were in"
    public static let turnOff = "Turn off here"
    public static let turnOn = "Turn back on"
}
