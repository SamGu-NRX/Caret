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
        }

        public var kind: Kind
        public var label: String?
        public var text: String
        /// "(picked from the list)", "already so".
        public var note: String?
        public var state: PageTask.Row.State?

        public init(kind: Kind, label: String? = nil, text: String, note: String? = nil, state: PageTask.Row.State? = nil) {
            self.kind = kind
            self.label = label
            self.text = text
            self.note = note
            self.state = state
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

    public init(task t: PageTask, stoppable: Bool) {
        page = t.page
        let current = t.current
        var sections: [Section] = []
        for (i, g) in t.groups.enumerated() {
            sections.append(Section(caption: i == 0 ? nil : PageTaskCopy.continuation(g), lines: Self.lines(g), marks: g.accepted))
        }
        self.sections = sections
        let presses = t.groups.flatMap { $0.rows.filter(\.yours) }
        var yours = t.attach.map { Line(kind: .yours, text: PageTaskCopy.attach($0)) } + presses.map { Line(kind: .yours, text: PageTaskCopy.press($0.says)) }
        from = t.from.isEmpty ? nil : "from \(t.from)"
        switch t.stage {
        case .preview:
            title = PageTaskCopy.title(t)
            lead = nil
            hints = [Hint(key: "Tab", label: PageTaskCopy.tabLabel(current)), Hint(key: "Esc")]
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

    static func lines(_ g: PageTask.Group) -> [Line] {
        var out: [Line] = []
        for r in g.rows where !r.yours {
            let note: String? = r.state == .already ? PageTaskCopy.already : (r.picked ? PageTaskCopy.picked : nil)
            if let label = r.label, let value = r.value {
                out.append(Line(kind: .field, label: label, text: value, note: note, state: r.state))
            } else {
                out.append(Line(kind: .step, text: r.says, note: r.state == .already ? PageTaskCopy.already : nil, state: r.state))
            }
        }
        out += g.withheld.map { Line(kind: .withheld, text: $0) }
        return out
    }

    /// What VoiceOver announces when it changes: the sentence and what the keys do.
    public var announcement: String {
        let keys = hints.map { [$0.key == "Esc" ? "Escape" : $0.key == "⌘Z" ? "Command Z" : $0.key, $0.label].compactMap { $0 }.joined(separator: " ") }
        return ([[lead, title].compactMap { $0 }.joined(separator: " ")] + keys).joined(separator: ". ")
    }

    /// Everything the panel says, for VoiceOver: the title, the source, each line with its state, the keys.
    public var spoken: String {
        var parts = [[lead, title].compactMap { $0 }.joined(separator: " ")]
        if let from { parts.append(from) }
        for s in sections {
            if let c = s.caption { parts.append(c) }
            for l in s.lines {
                let state = l.state.map(PageTaskCopy.spokenState) ?? ""
                parts.append([l.label, l.text, l.note, state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
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

    /// The panel's title while a group waits or runs.
    public static func title(_ t: PageTask) -> String {
        let first = t.groups[0]
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

    public static func tabLabel(_ g: PageTask.Group) -> String { "Fill \(g.writes)" }

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
