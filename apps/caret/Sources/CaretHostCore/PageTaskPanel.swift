import CaretScreenCore
import CoreGraphics
import Foundation

/// What the page task panel shows, derived from a `PageTask` (fast-browser.md, "UI moments" 1 to 6). Plain
/// strings and states, so every state is tested and rendered without a screen; `PageTaskView` lays it out.
public struct PageTaskPanel: Equatable, Sendable {
    public enum Figure: String, Codable, Sendable {
        case offering, working, done, stopped
    }

    public struct Line: Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            /// A field Caret writes: its label in the key column, its value beside it.
            case field
            /// A step that reads as one sentence ("Tick 'Do you have a valid driving license?'").
            case step
            /// What the helper left to the user, in its words, in secondary ink.
            case withheld
            /// The user's own step, in accent: a press Caret leaves to them, a file to attach.
            case yours
            /// H14: an attach row in a preview: the control's name in the key column, then "Choose a file…" or the
            /// file, and its key at the trailing edge. ⌘2, ⌘3 or a click acts on it.
            case attach
        }

        /// H14: an attach row's state and what acting on it does.
        public struct Attach: Equatable, Sendable {
            public enum State: String, Codable, Sendable {
                /// No file yet: acting opens the open panel.
                case choose
                /// A saved file offered, not yet confirmed: acting confirms it for this Tab.
                case offered
                /// The user's file for this Tab: acting opens the open panel to change it.
                case confirmed
            }
            /// The attach step's index, for a click.
            public var step: Int
            public var state: State
            /// "⌘2", "⌘3"; nil past the third row, which only a click acts on.
            public var key: String?
            /// What the key does: "Attach", "Change"; nil when the row's own words say it ("Choose a file…").
            public var action: String?
        }

        public var kind: Kind
        public var label: String?
        public var text: String
        /// "(picked from the list)", "already so"; on an attach row, why its file was not taken.
        public var note: String?
        public var state: PageTask.Row.State?
        public var attach: Attach?
        /// The text wraps rather than being cut: a file's name and date are always shown whole (H14).
        public var wraps: Bool

        public init(kind: Kind, label: String? = nil, text: String, note: String? = nil, state: PageTask.Row.State? = nil, attach: Attach? = nil, wraps: Bool = false) {
            self.kind = kind
            self.label = label
            self.text = text
            self.note = note
            self.state = state
            self.attach = attach
            self.wraps = wraps || attach != nil
        }
    }

    public struct Section: Equatable, Sendable {
        /// Over a continuation, under a hairline: "2 more fields appeared".
        public var caption: String?
        public var lines: [Line]
        /// The group was accepted: its rows carry marks (to do, written, stopped). A preview shows none.
        public var marks: Bool
    }

    /// Caret's sentence: "Fill 12 fields on this page", "Next page: fill 9 fields", the helper's ending.
    public var title: String
    /// The first words of a result, in Carrot text: "Done", "Partly done".
    public var lead: String?
    /// "from Notes and what you told Caret".
    public var from: String?
    public var sections: [Section]
    /// The user's own steps, last: files to attach, then the press.
    public var yours: [Line]
    public var hints: [Hint]
    public var figure: Figure
    /// The page the content is for: a change crossfades the content (UI moment 5).
    public var page: Int

    /// `now` dates a file's "edited Tue".
    public init(task t: PageTask, stoppable: Bool, now: Date = Date(), calendar: Calendar = .current) {
        page = t.page
        let current = t.current
        var sections: [Section] = []
        for (i, g) in t.groups.enumerated() {
            sections.append(Section(caption: i == 0 ? nil : PageTaskCopy.continuation(g), lines: Self.lines(g, now: now, calendar: calendar), marks: g.accepted))
        }
        self.sections = sections
        let presses = t.groups.flatMap { $0.rows.filter(\.yours) }
        // An attach row Tab sent no file for is left to the user, like a file input with no row. So is a waiting row past
        // the ones with a key (prep-for-prod H14-2): a row only a pointer could reach would leave keyboard users out, and
        // the page's own control is theirs either way.
        let unattached = t.groups.filter(\.accepted).flatMap { g in g.rows.filter { $0.kind == .attach && !$0.runs }.compactMap { $0.attach?.label } }
            + t.groups.filter { !$0.accepted }.flatMap { $0.attachRows.dropFirst(PageTaskCopy.attachKeys.count).compactMap { $0.attach?.label } }
        var yours = (t.attach + unattached).map { Line(kind: .yours, text: PageTaskCopy.attach($0)) } + presses.map { Line(kind: .yours, text: PageTaskCopy.press($0.says)) }
        from = t.from.isEmpty ? nil : "from \(t.from)"
        switch t.stage {
        case .preview:
            title = PageTaskCopy.title(t)
            lead = nil
            // A preview that only attaches takes Tab once it has a file; before that its row's key is the next step.
            let tab = current.writes > 0 || current.confirmedFile != nil
            hints = (tab ? [Hint(key: "Tab", label: PageTaskCopy.tabLabel(current))] : []) + [Hint(key: "Esc")]
            figure = .offering
        case .running:
            title = PageTaskCopy.title(t)
            lead = nil
            hints = stoppable ? [Hint(key: "Esc", label: "Stop")] : []
            figure = .working
        case .stopping:
            title = PageTaskCopy.stopping
            lead = nil
            hints = []
            figure = .working
        case .ended(let e):
            let (l, rest) = PageTaskCopy.ending(e, undo: t.undo)
            lead = l
            title = rest
            // I6: a finished goal's sentence ends with its hand-off ("Done: 2 steps verified. You press Next."). The
            // title says the result; the hand-off is the panel's last row, in accent, and a row never repeats it.
            if case .finished(let end) = e, t.undo == .none || t.undo == .available, let handoff = PageTaskCopy.handoff(end.says),
               !yours.contains(where: { PageTaskCopy.same($0.text, handoff) }) {
                yours.append(Line(kind: .yours, text: handoff))
            }
            hints = t.undo == .available ? [Hint(key: "⌘Z", label: "Undo")] : []
            switch e {
            case .finished(let end): figure = end.outcome == .done ? .done : .stopped
            case .stopped(let s): figure = s.reason == .you ? .done : .stopped
            case .notRun, .lostTouch: figure = .stopped
            }
            if case .undone = t.undo { figure = .done }
        }
        self.yours = yours
    }

    static func lines(_ g: PageTask.Group, now: Date, calendar: Calendar) -> [Line] {
        var out: [Line] = []
        let keys = Dictionary(uniqueKeysWithValues: g.attachRows.prefix(PageTaskCopy.attachKeys.count).enumerated().map { ($1.step, PageTaskCopy.attachKeys[$0]) })
        for r in g.rows where !r.yours {
            let note: String? = r.state == .already ? PageTaskCopy.already : (r.picked ? PageTaskCopy.picked : nil)
            if r.kind == .attach, let a = r.attach {
                if !g.accepted {
                    // Only a row with a key is drawn as one; the rest are the user's, in the panel's last lines.
                    if let key = keys[r.step] { out.append(Self.attachLine(r.step, a, key: key.label, now: now, calendar: calendar)) }
                } else if let file = a.confirmed {
                    // Sent with Tab: a row like a field's, with its mark as the run goes.
                    out.append(Line(kind: .field, label: a.label, text: file.says(now: now, calendar: calendar), state: r.state, wraps: true))
                }
                continue
            }
            if let label = r.label, let value = r.value {
                out.append(Line(kind: .field, label: label, text: value, note: note, state: r.state))
            } else {
                out.append(Line(kind: .step, text: r.says, note: r.state == .already ? PageTaskCopy.already : nil, state: r.state))
            }
        }
        out += g.withheld.map { Line(kind: .withheld, text: $0) }
        return out
    }

    static func attachLine(_ step: Int, _ a: PageTask.Row.Attach, key: String?, now: Date, calendar: Calendar) -> Line {
        let state: Line.Attach.State
        let text: String
        let action: String?
        if let file = a.confirmed {
            (state, text, action) = (.confirmed, file.says(now: now, calendar: calendar), PageTaskCopy.change)
        } else if let saved = a.savedFile {
            (state, text, action) = (.offered, saved.says(now: now, calendar: calendar), PageTaskCopy.attachSaved)
        } else {
            (state, text, action) = (.choose, PageTaskCopy.choose, nil)
        }
        return Line(kind: .attach, label: a.label, text: text, note: a.problem, attach: Line.Attach(step: step, state: state, key: key, action: action))
    }

    /// What VoiceOver announces when it changes: the sentence and what the keys do.
    public var announcement: String {
        let keys = hints.map { [$0.key == "Esc" ? "Escape" : $0.key == "⌘Z" ? "Command Z" : $0.key, $0.label].compactMap { $0 }.joined(separator: " ") }
        // H14: an attach row's key is said with the row it acts on: "Resume: Command 2, Choose a file…".
        let rows = sections.flatMap(\.lines).compactMap { l -> String? in
            guard let a = l.attach, let key = a.key else { return nil }
            // The row's note too: "Choose a file first, then press Tab", or why its file was not taken (prep-for-prod H14-3).
            return "\(l.label ?? ""): \(PageTaskCopy.spokenKey(key)), \(a.action.map { "\($0) \(l.text)" } ?? l.text)" + (l.note.map { ". \($0)" } ?? "")
        }
        return ([[lead, title].compactMap { $0 }.joined(separator: " ")] + rows + keys).joined(separator: ". ")
    }

    /// Everything the panel says, for VoiceOver: the title, the source, each line with its state, the keys.
    public var spoken: String {
        var parts = [[lead, title].compactMap { $0 }.joined(separator: " ")]
        if let from { parts.append(from) }
        for s in sections {
            if let c = s.caption { parts.append(c) }
            for l in s.lines {
                let state = l.state.map(PageTaskCopy.spokenState) ?? ""
                let key = l.attach.map { a in [a.key.map(PageTaskCopy.spokenKey), a.action].compactMap { $0 }.joined(separator: " ") } ?? ""
                parts.append([l.label, l.text, l.note, state, key].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
            }
        }
        parts += yours.map(\.text)
        parts += hints.map { [$0.key, $0.label].compactMap { $0 }.joined(separator: " ") }
        return parts.joined(separator: ". ")
    }
}

/// Every sentence the page task panel says (`unslop`: plain words, no em dashes, the helper's words where it
/// has them).
public enum PageTaskCopy {
    public static func fields(_ n: Int) -> String { n == 1 ? "1 field" : "\(n) fields" }

    /// The panel's title while a group waits or runs. A page with only a file to attach says that.
    public static func title(_ t: PageTask) -> String {
        let first = t.groups[0]
        if first.writes == 0, !first.attachRows.isEmpty {
            let what = first.attachRows.count == 1 ? "a file" : "files"
            return t.page > 1 ? "Next page: attach \(what)" : "Attach \(what) on this page"
        }
        if t.page > 1 { return "Next page: fill \(fields(first.writes))" }
        return "Fill \(fields(first.writes)) on this page"
    }

    /// The caption over a group that continues the task.
    public static func continuation(_ g: PageTask.Group) -> String {
        switch g.reason {
        case .afterReveal: return g.writes == 1 ? "1 more field appeared" : "\(g.writes) more fields appeared"
        // C2: the next part of a long form, shown as a reveal is ("20 more fields", then its own Tab).
        case .moreFields: return g.writes == 1 ? "1 more field" : "\(g.writes) more fields"
        case .freshPlan: return "Ready again: \(fields(g.writes))"
        case .start, .crossWindow, .nextPage: return "Then \(fields(g.writes))"
        }
    }

    public static func tabLabel(_ g: PageTask.Group) -> String { g.writes == 0 ? attachSaved : "Fill \(g.writes)" }

    // H14: attach rows.
    /// The keys the first attach rows take, in order: ⌘1 stays the host's, since ⌘1 means "all" elsewhere in Caret.
    public static let attachKeys: [(key: PopupSpec.Action.Key, label: String)] = [(.cmd2, "⌘2"), (.cmd3, "⌘3")]
    public static let choose = "Choose a file…"
    public static let attachSaved = "Attach"
    public static let change = "Change"
    public static let chooseFirst = "Choose a file first, then press Tab."

    /// The row's line when the helper would not take the file the user confirmed and keeps the preview waiting
    /// (runs.ts: "Caret can't attach the file you chose (a link); nothing ran, so choose another and accept again", or a
    /// preview of attach rows alone accepted with none). Nil for every other refusal, which ends the task.
    public static func fileRefusal(_ why: String, sent: Bool) -> String? {
        if sent, why.hasPrefix("Caret can't attach the file you chose") {
            let head = why.components(separatedBy: ";").first ?? why
            return head.trimmingCharacters(in: CharacterSet(charactersIn: ". ")) + ". Choose another file."
        }
        if !sent, why.hasPrefix("this preview only attaches files") { return chooseFirst }
        return nil
    }

    static func spokenKey(_ key: String) -> String { key.replacingOccurrences(of: "⌘", with: "Command ") }

    public static let picked = "(picked from the list)"
    public static let already = "already so"
    public static let stopping = "Stopping"
    public static let expired = "That preview waited too long for Tab, so nothing ran. Ask again."
    public static let helperGone = "Caret's helper stopped, so this can't run now."
    public static let lostTouch = "Caret's helper stopped answering, so check the page."
    public static let undoing = "Putting the page back"
    public static let undoUnanswered = "Caret's helper didn't confirm the undo, so check the page."

    /// A file input Caret leaves to the user until it can attach (P3).
    public static func attach(_ label: String) -> String { "Attach '\(label)' yourself" }

    /// A press the helper hands to the user, as one short sentence: "You press 'Next'." The helper's own words
    /// when they do not name a press.
    public static func press(_ says: String) -> String {
        let s = says.trimmingCharacters(in: .whitespaces)
        if let label = quoted(s), s.hasSuffix("you press it") || s.lowercased().hasPrefix("you press '") { return "You press '\(label)'." }
        return s.hasSuffix(".") ? s : "\(s)."
    }

    private static func quoted(_ s: String) -> String? {
        guard let a = s.firstIndex(of: "'") else { return nil }
        let rest = s[s.index(after: a)...]
        guard let b = rest.firstIndex(of: "'"), b > rest.startIndex else { return nil }
        return String(rest[..<b])
    }

    public static func acceptRefused(_ why: String) -> String {
        let w = why.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return AskCopy.showable(w) ? "Nothing ran: \(w)." : "Caret's helper didn't take that, so nothing ran."
    }

    /// An ending as the panel says it: the helper's own sentence, its first words ("Done", "Partly done",
    /// "Ready") as the lead when it opens with them and a colon. After ⌘Z, what was put back.
    public static func ending(_ e: PageTask.Ending, undo: PageTask.Undo) -> (lead: String?, text: String) {
        switch undo {
        case .undoing: return (nil, undoing)
        case .undone(let n): return n > 0 ? ("Cleared", "\(fields(n)) on this page") : (nil, undoUnanswered)
        case .none, .available: break
        }
        var says: String
        switch e {
        case .finished(let end):
            says = end.says
            // A finished sentence may go on to name the hand-off ("Done: 2 steps verified. You press Next."), which the
            // panel's last row says in accent: the title keeps its first sentence only, so it is said once.
            if end.outcome == .handoff || handoff(end.says) != nil, let stop = says.range(of: ". ") { says = String(says[..<stop.lowerBound]) + "." }
        case .stopped(let stop): says = stop.says
        case .notRun(let line): return (nil, line)
        case .lostTouch: return (nil, lostTouch)
        }
        if let colon = says.firstIndex(of: ":"), says.distance(from: says.startIndex, to: colon) <= 14 {
            let head = String(says[..<colon])
            if head.split(separator: " ").count <= 2, head.first?.isUppercase == true {
                // The colon stays with the lead: "Partly done: 9 fields verified." reads as the helper wrote it.
                return (head + ":", String(says[says.index(after: colon)...]).trimmingCharacters(in: .whitespaces))
            }
        }
        return (nil, says)
    }

    /// The hand-off a finished sentence ends with, as the panel's last row says it: its second sentence when that
    /// names what is the user's ("You press Next.", "The rest is yours."); nil otherwise.
    public static func handoff(_ says: String) -> String? {
        guard let stop = says.range(of: ". ") else { return nil }
        let rest = says[stop.upperBound...].trimmingCharacters(in: .whitespaces)
        guard rest.hasPrefix("You press ") || rest.hasPrefix("The rest is yours") else { return nil }
        return rest.hasSuffix(".") ? rest : rest + "."
    }

    /// Two of the panel's sentences say the same thing, quotes and the final stop aside ("You press 'Next'." and
    /// "You press Next.").
    static func same(_ a: String, _ b: String) -> Bool {
        let norm = { (s: String) in s.replacingOccurrences(of: "'", with: "").trimmingCharacters(in: CharacterSet(charactersIn: ". ")).lowercased() }
        return norm(a) == norm(b)
    }

    static func spokenState(_ s: PageTask.Row.State) -> String {
        switch s {
        case .pending: return ""
        case .writing: return "writing"
        case .verified: return "filled"
        case .already: return ""
        case .failed: return "not filled"
        }
    }
}
