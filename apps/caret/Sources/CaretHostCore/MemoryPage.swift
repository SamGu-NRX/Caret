import CaretScreenCore
import Foundation

/// What the memory window shows, computed from `MemoryBook.State`: the kinds of memory as sections
/// of rows (skills among them, and anything a newer helper keeps that this host cannot name), and
/// the permissions as one row per action type, with the skills that skip Ask first under them. The window only draws these.
/// Each row's title and secondary line are composed here from the entry's structured fields, in
/// plain words: the title says what Caret remembers, the secondary line says where it came from
/// and how sure Caret is. The helper's own sentence (`says`) is left to the debug state.
public enum MemoryPage {
    public enum Control: String, Codable, Sendable { case edit, pause, resume, forget, backOnTab }

    public struct Row: Equatable, Sendable, Identifiable {
        public enum Status: Equatable, Sendable {
            case active, learning, paused
            /// Typed by hand and not kept by the helper yet.
            case notSaved
            /// Typed by hand and refused by the helper.
            case refused
        }

        public var id: String
        public var kind: HelperMemory.Kind
        /// "Your guest is Marcus Lowe (ops)".
        public var title: String
        /// "You set this · today 9:14 AM · Mail": status, provenance, counts.
        public var secondary: String
        public var status: Status
        public var controls: [Control]
        public var busy: Bool
        /// The last refusal, or a typed value's reason, in words.
        public var problem: String?
        /// A value typed by hand, held by the host until the helper keeps it.
        public var typed: Bool
    }

    public struct Section: Equatable, Sendable, Identifiable {
        public var kind: HelperMemory.Kind
        public var title: String
        /// Shown under the title when the section has no rows.
        public var empty: String
        public var rows: [Row]
        public var id: HelperMemory.Kind { kind }
    }

    public struct RuleRow: Equatable, Sendable, Identifiable {
        public struct UseLine: Equatable, Sendable {
            public var says: String
            public var when: String
        }

        public var id: String
        public var action: HelperMemory.ActionType
        public var title: String
        public var example: String
        public var rule: HelperMemory.Rule
        /// What the current rule means, as a sentence.
        public var ruleDetail: String
        /// The rules the user may pick, least autonomous first; empty when the rule is fixed.
        public var choices: [HelperMemory.Rule]
        /// The last five uses, newest first.
        public var uses: [UseLine]
        /// False when the helper does not report uses at all (today's helper).
        public var usesReported: Bool
        public var busy: Bool
        public var problem: String?
    }

    /// The sections in order. `noticed` is listed only when it has rows.
    public static let kinds: [HelperMemory.Kind] = [.about, .people, .preference, .routine, .skill, .noticed]

    public static func title(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "About you"
        case .people: return "People"
        case .preference: return "Preferences"
        case .routine: return "Routines"
        case .permission: return "Permissions"
        case .skill: return "Skills"
        case .noticed: return "Something Caret noticed"
        }
    }

    static func emptyLine(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "Nothing yet. When you correct a value Caret filled, the right one shows up here."
        case .people: return "Nobody yet. When you write out a name Caret shortened, it remembers who you meant."
        case .preference: return "None yet. When you reformat what Caret filled, the format shows up here."
        case .routine: return "None yet. Steps you repeat between the same apps show up here as Caret learns them."
        case .skill: return "None yet. After Caret runs a routine for you, it asks whether to keep it as a skill."
        case .permission, .noticed: return ""
        }
    }

    // MARK: - Memory

    public static func sections(_ s: MemoryBook.State, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [Section] {
        kinds.compactMap { kind in
            var rows = s.entries.filter { $0.kind == kind }.map { row($0, s, now: now, calendar: calendar, locale: locale) }
            if kind == .about { rows += s.typed.map(typedRow) }
            if kind == .noticed, rows.isEmpty { return nil }
            return Section(kind: kind, title: title(kind), empty: emptyLine(kind), rows: rows)
        }
    }

    static func row(_ e: HelperMemory.Entry, _ s: MemoryBook.State, now: Date, calendar: Calendar, locale: Locale) -> Row {
        let status: Row.Status
        switch e.status {
        case .active: status = .active
        case .learning: status = .learning
        case .paused: status = .paused
        }
        var controls: [Control] = []
        if !MemoryBook.editable(e).isEmpty { controls.append(.edit) }
        if e.skill?.onItsOwn == true, e.status != .paused { controls.append(.backOnTab) }
        // Something this host cannot name: it shows the helper's sentence and can only be forgotten.
        if e.kind != .noticed { controls.append(e.status == .paused ? .resume : .pause) }
        controls.append(.forget)
        let words = wording(e, entries: s.entries, now: now, calendar: calendar, locale: locale)
        return Row(
            id: e.id, kind: e.kind, title: words.title, secondary: words.secondary,
            status: status, controls: controls, busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id], typed: false
        )
    }

    static func typedRow(_ t: MemoryBook.Typed) -> Row {
        let problem: String?
        let status: Row.Status
        switch t.phase {
        case .waiting, .sending:
            status = .notSaved
            problem = nil
        case .refused(let reason):
            status = .refused
            problem = "Caret couldn't keep this: \(reason)"
        }
        return Row(
            id: t.id, kind: .about, title: aboutTitle(label: t.label, value: t.value),
            secondary: joined(["you typed this during setup", statusText(status)?.lowercased()]),
            status: status, controls: [.forget], busy: false, problem: problem, typed: true
        )
    }

    // MARK: - Wording

    /// A row's title and secondary line, from the entry's fields. `entries` resolves a use-instead
    /// preference's About-you value.
    public static func wording(_ e: HelperMemory.Entry, entries: [HelperMemory.Entry], now: Date, calendar: Calendar, locale: Locale) -> (title: String, secondary: String) {
        let paused = e.status == .paused ? "paused" : nil
        let seen = e.evidence.lastSeen > 0 ? when(e.evidence.lastSeen, now: now, calendar: calendar, locale: locale) : nil
        switch e.fields {
        case .about(let f):
            let source: String
            switch f.source {
            case .edit: source = "you set this"
            case .typed: source = "you typed this"
            case .contacts: source = "from your Contacts card"
            }
            return (aboutTitle(label: f.label, value: f.value), joined([paused, source, seen, e.evidence.app]))
        case .people(let f):
            let title = e.evidence.app.map { "\(f.alias) in \($0) means \(f.name)" } ?? "\(f.alias) means \(f.name)"
            return (title, joined([paused, "picked \(times(e.evidence.count))"]))
        case .preference(let p):
            let title: String
            let how: String
            switch p {
            case .format(let template):
                title = "Phone numbers go in as \(sampleNumber(template))"
                how = "you changed it \(times(e.evidence.count))"
            case .useInstead(let field, let aboutId):
                // The helper substitutes only an About entry that exists and is not paused
                // (memory.ts `about`), so the title says what a fill gets today.
                let about = entries.first { $0.id == aboutId }
                switch (about?.about?.value, about?.status) {
                case (let value?, .paused?): title = "\(field) fields would get \(value), but it's paused"
                case (let value?, _): title = "\(field) fields get \(value)"
                default: title = "\(field) fields get a value Caret no longer has"
                }
                how = "you changed it \(times(e.evidence.count))"
            case .dontOffer(let offerKind, let appName):
                title = "No \(offerWords(offerKind)) in \(appName)"
                how = "you turned this off"
            }
            return (title, joined([paused, how, seen]))
        case .routine(let r):
            let copies = "Copies \(r.steps == 1 ? "1 value" : "\(r.steps) values") from \(list(r.srcApps)) into \(r.dstApp)"
            let state: String
            switch e.status {
            case .learning: state = "still learning"
            case .active: state = "learned"
            case .paused: state = "paused"
            }
            let tries = r.silent.hits + r.silent.misses
            let record: String
            switch tries {
            case 0: record = "seen \(times(e.evidence.count))"
            case 1: record = r.silent.hits == 1 ? "right the one time so far" : "wrong the one time so far"
            default: record = "right \(r.silent.hits) of \(tries) times"
            }
            if let name = r.name, !name.isEmpty { return (name, joined([copies, state, record])) }
            return (copies, joined([state, record]))
        case .permission(let p):
            return (actionTitle(p.action), ruleTitle(p.rule))
        case .skill(let f):
            return (f.name, joined([skillState(f, paused: e.status == .paused), "when \(f.trigger)", "ran \(times(f.runs))"]))
        case .noticed:
            return (e.says, joined([paused, seen, e.evidence.app]))
        }
    }

    /// Where a skill stands, in the three words the list uses: learning (on Tab, counting clean runs),
    /// on Tab (it stays there: it hands a press to you, or it has earned more and you kept it asking),
    /// or on its own.
    public static func skillState(_ f: SkillFields, paused: Bool) -> String {
        if paused { return "Paused" }
        if f.onItsOwn { return "On its own" }
        if let handsOff = f.handsOff { return "On Tab, you press \(handsOff.label) yourself" }
        if f.cleanRuns >= f.needed { return "On Tab" }
        return "Learning, \(f.cleanRuns) of \(f.needed) clean runs"
    }

    /// "Your guest is Marcus Lowe (ops)". The label keeps its capitals when it is an initialism
    /// ("URL", "ZIP code").
    static func aboutTitle(label: String, value: String) -> String {
        let chars = Array(label)
        let initialism = chars.count > 1 && chars[0].isUppercase && chars[1].isUppercase
        let lowered = initialism || chars.isEmpty ? label : String(chars[0]).lowercased() + String(chars.dropFirst())
        return "Your \(lowered) is \(value)"
    }

    /// The parts that are there, joined by middle dots, the first one capitalized.
    static func joined(_ parts: [String?]) -> String {
        let text = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// "once", "twice", "3 times".
    static func times(_ n: Int) -> String {
        switch n {
        case 1: return "once"
        case 2: return "twice"
        default: return "\(n) times"
        }
    }

    /// "Mail", "Mail and Notes", "Mail, Notes and Safari".
    static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "another app" }
        return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }

    /// The format shown with sample digits, never anyone's number: "###-###-####" as 512-555-0100.
    static func sampleNumber(_ template: String) -> String {
        var digits = Array("512555010012345")
        return String(template.map { c in c == "#" && !digits.isEmpty ? digits.removeFirst() : c })
    }

    /// What a don't-offer rule stops, by the helper's offer kind (protocol.ts OfferKind).
    static func offerWords(_ kind: String) -> String {
        switch kind {
        case "loopNext": return "next-row suggestions"
        case "loopFinish": return "offers to finish the rest"
        case "routine": return "routine offers"
        default: return "offers of this kind"
        }
    }

    /// "today 9:14 AM", "yesterday 9:14 AM", "Oct 1" before that.
    public static func when(_ ms: Int64, now: Date, calendar: Calendar, locale: Locale) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let time = DateFormatter()
        time.locale = locale
        time.timeZone = calendar.timeZone
        time.dateStyle = .none
        time.timeStyle = .short
        if calendar.isDate(date, inSameDayAs: now) { return "today \(time.string(from: date))" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "yesterday \(time.string(from: date))"
        }
        let day = DateFormatter()
        day.locale = locale
        day.timeZone = calendar.timeZone
        day.setLocalizedDateFormatFromTemplate("MMMd")
        return day.string(from: date)
    }

    /// Plain words for a row's status; nil for active, which needs none.
    public static func statusText(_ s: Row.Status) -> String? {
        switch s {
        case .active: return nil
        case .learning: return "Learning"
        case .paused: return "Paused"
        case .notSaved: return "Not saved yet"
        case .refused: return "Not saved"
        }
    }

    public static func controlTitle(_ c: Control, kind: HelperMemory.Kind? = nil) -> String {
        switch c {
        case .edit: return kind == .skill ? "Rename" : "Edit"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .forget: return "Forget"
        case .backOnTab: return "Put back on Tab"
        }
    }

    /// The question on a row whose Forget waits for confirmation.
    public static func forgetQuestion(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .routine: return "Forget this routine? Caret won't relearn it for 30 days."
        // memory.ts `forget`: the routine stays, marked declined.
        case .skill: return "Forget this skill? Caret won't ask to keep it again."
        default: return "Forget this? Caret can't bring it back."
        }
    }

    // MARK: - Skills that skip Ask first

    /// One skill the permissions page names as an exception to Ask first.
    public struct Exception: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        /// "When a Tracker window opens with Order, Carrier and Tracking empty".
        public var when: String
        public var busy: Bool
        public var problem: String?
    }

    /// Every skill that runs on its own and is not paused, in the helper's order. The helper does not
    /// say which permission a skill's runs fall under, so the list sits under both write rows.
    public static func exceptions(_ s: MemoryBook.State) -> [Exception] {
        s.entries.compactMap { e in
            guard let f = e.skill, f.onItsOwn, e.status != .paused else { return nil }
            return Exception(id: e.id, name: f.name, when: "When \(f.trigger)", busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id])
        }
    }

    public static let exceptionsTitle = "Skills that run on their own"
    public static let exceptionsDetail = "These skip Ask first. Each run shows where you are, and ⌘Z undoes it."


    // MARK: - Permissions

    public static func rules(_ s: MemoryBook.State, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [RuleRow] {
        HelperMemory.ActionType.allCases.compactMap { action in
            guard let e = s.entries.first(where: { $0.permission?.action == action }), let p = e.permission else { return nil }
            let choices = p.fixed ? [] : PermissionPolicy.allowed(action)
            let uses = (e.uses ?? []).prefix(5).map { use in
                RuleRow.UseLine(says: use.says, when: when(use.at, now: now, calendar: calendar, locale: locale))
            }
            return RuleRow(
                id: e.id, action: action, title: actionTitle(action), example: actionExample(action), rule: p.rule,
                ruleDetail: ruleDetail(action, p.rule), choices: choices.count > 1 ? choices : [], uses: Array(uses),
                usesReported: e.uses != nil, busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id]
            )
        }
    }

    public static func actionTitle(_ a: HelperMemory.ActionType) -> String {
        switch a {
        case .read: return "Read and prepare"
        case .show: return "Show things where you type"
        case .writeHere: return "Write where you are"
        case .writeElsewhere: return "Undoable changes in other apps"
        case .outbound: return "Send, submit, post"
        case .destructive: return "Delete or overwrite"
        case .sensitive: return "Money, passwords, system prompts"
        }
    }

    public static func actionExample(_ a: HelperMemory.ActionType) -> String {
        switch a {
        case .read: return "Look over your windows, check free time"
        case .show: return "Next words, a fill line, a card"
        case .writeHere: return "Put text in, fill the form you're in"
        case .writeElsewhere: return "Add an event, fill a window in the back"
        case .outbound: return "Messages, forms, posts"
        case .destructive: return "Remove or replace what's there"
        case .sensitive: return "Payments, passwords, permission prompts"
        }
    }

    public static func ruleTitle(_ r: HelperMemory.Rule) -> String {
        switch r {
        case .act: return "Act"
        case .actIfApproved: return "Act if approved"
        case .ask: return "Ask first"
        case .handoff: return "Hand off"
        }
    }

    /// What the rule does today. The helper's gate reads only Write where you are and Undoable
    /// changes: Hand off holds the offer (helper/src/patterns/gate.ts, `permissionHandoff`), and a
    /// skill the user promoted runs without Tab under Ask first or Act where you are, and under Act if
    /// approved elsewhere (B19, skills.ts `mayRunUnasked`). Nothing else acts without Tab, so Act says
    /// so rather than promise it; reading and showing do happen without asking.
    public static func ruleDetail(_ a: HelperMemory.ActionType, _ r: HelperMemory.Rule) -> String {
        switch r {
        case .act where a == .read || a == .show: return "Caret does it without asking."
        // B19: only a skill the user let run on its own acts without Tab (skills.ts mayRunUnasked); elsewhere
        // that needs Act if approved.
        case .act, .actIfApproved: return "Skills you let run on their own act without Tab. Anything else, Tab still does."
        case .ask: return "Caret offers it, and Tab does it."
        case .handoff: return "Caret leaves it to you."
        }
    }

    /// Under the permissions list: the limit no setting moves.
    public static let ceiling = "Sending, deleting, money and passwords never go past Ask first."
    public static let usesNone = "No uses recorded yet."
}
