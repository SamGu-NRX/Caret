import CaretScreenCore
import Foundation

/// What the memory window shows, computed from `MemoryBook.State`: the kinds of memory as sections
/// of rows (skills among them, and anything a newer helper keeps that this host cannot name), and
/// the permissions as one row per action type, with the skills on their own under the write rules
/// they write under. The window only draws these.
/// Each row's title and secondary line are composed here from the entry's structured fields, in
/// plain words: the title says what Caret remembers, the secondary line says where it came from
/// and how sure Caret is. The helper's own sentence (`says`) is left to the debug state.
public enum MemoryPage {
    public enum Control: String, Codable, Sendable {
        case edit, pause, resume, forget, backOnTab, onItsOwn
        /// M1, on a noticed fact: make it the user's own (`MemoryBook.keepNoticed`).
        case keep
        /// M1, on a noticed fact: forget it, or type what is right (`MemoryBook.beginNotRight`).
        case notRight
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public enum Status: Equatable, Sendable {
            case active, learning, paused
            /// M1: Caret saw this itself; the row says where (`noticedLine`) and offers Keep and Not right.
            case noticed
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
        /// The helper's offer to let this skill run on its own, asked for from the row.
        public var question: MemoryBook.OnItsOwnQuestion? = nil
        /// "Noticed in Mail, Tue": where and when Caret saw a noticed fact.
        public var noticedLine: String? = nil
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

    /// The sections in order. `unrecognized` is listed only when it has rows.
    public static let kinds: [HelperMemory.Kind] = [.about, .people, .preference, .routine, .skill, .unrecognized]

    public static func title(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "About you"
        case .people: return "People"
        case .preference: return "Preferences"
        case .routine: return "Routines"
        case .permission: return "Permissions"
        case .skill: return "Skills"
        case .unrecognized: return "Kept by a newer Caret"
        }
    }

    static func emptyLine(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "Nothing yet. When you correct a value Caret filled, the right one shows up here."
        case .people: return "Nobody yet. When you write out a name Caret shortened, it remembers who you meant."
        case .preference: return "None yet. When you reformat what Caret filled, the format shows up here."
        case .routine: return "None yet. Steps you repeat between the same apps show up here as Caret learns them."
        case .skill: return "None yet. After Caret runs a routine for you, it asks whether to keep it as a skill."
        case .permission, .unrecognized: return ""
        }
    }

    // MARK: - Memory

    public static func sections(_ s: MemoryBook.State, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [Section] {
        kinds.compactMap { kind in
            var rows = s.entries.filter { $0.kind == kind }.map { row($0, s, now: now, calendar: calendar, locale: locale) }
            if kind == .about { rows += s.typed.map(typedRow) }
            if kind == .unrecognized, rows.isEmpty { return nil }
            return Section(kind: kind, title: title(kind), empty: emptyLine(kind), rows: rows)
        }
    }

    static func row(_ e: HelperMemory.Entry, _ s: MemoryBook.State, now: Date, calendar: Calendar, locale: Locale) -> Row {
        let status: Row.Status
        switch e.status {
        case .active: status = .active
        case .learning: status = .learning
        case .paused: status = .paused
        case .noticed: status = .noticed
        }
        var controls: [Control] = []
        if e.status == .noticed {
            // Caret saw it and uses it; the user's two answers are to make it theirs or to say it's
            // wrong (which forgets it or replaces it). Edit and Pause wait until it is theirs.
            if !MemoryBook.editable(e).isEmpty { controls.append(.keep) }
            controls.append(.notRight)
            let words = wording(e, entries: s.entries, now: now, calendar: calendar, locale: locale)
            return Row(
                id: e.id, kind: e.kind, title: words.title, secondary: "", status: status, controls: controls,
                busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id], typed: false,
                noticedLine: e.noticed.map { noticedLine($0, now: now, calendar: calendar, locale: locale) } ?? "Noticed by Caret"
            )
        }
        if !MemoryBook.editable(e).isEmpty { controls.append(.edit) }
        if e.skill?.onItsOwn == true, e.status != .paused { controls.append(.backOnTab) }
        if mayAskOnItsOwn(e, s) { controls.append(.onItsOwn) }
        // Something this host cannot name: it shows the helper's sentence and can only be forgotten.
        if e.kind != .unrecognized { controls.append(e.status == .paused ? .resume : .pause) }
        controls.append(.forget)
        let words = wording(e, entries: s.entries, now: now, calendar: calendar, locale: locale)
        return Row(
            id: e.id, kind: e.kind, title: words.title, secondary: words.secondary,
            status: status, controls: controls, busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id], typed: false,
            question: s.questions[e.id]
        )
    }

    /// Whether a skill's row offers "Let it run on its own…": a skill on Tab, not paused, that hands
    /// no press to the user (the helper never lets one run on its own), with no question open, from
    /// a helper that offers it. The helper checks again and may still refuse, saying why.
    public static func mayAskOnItsOwn(_ e: HelperMemory.Entry, _ s: MemoryBook.State) -> Bool {
        guard s.offersOnItsOwn, let f = e.skill, !f.onItsOwn, f.handsOff == nil, e.status != .paused else { return false }
        return s.questions[e.id] == nil
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
            case .active, .noticed: state = "learned"
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
        case .unrecognized:
            return (e.says, joined([paused, seen, e.evidence.app]))
        }
    }

    /// Where a skill stands, in the three words the list uses: learning (on Tab, counting clean runs),
    /// on Tab (it stays there: it hands a press to you, or it has earned more and you kept it asking),
    /// or on its own.
    public static func skillState(_ f: SkillFields, paused: Bool) -> String {
        if paused { return "Paused" }
        if f.onItsOwn { return "On its own" }
        if let handsOff = f.handsOff {
            switch handsOff.why {
            case .outbound, .destructive, .money: return "On Tab, you press \(handsOff.label) yourself"
            // B22: a press in a permission dialog or system prompt, whatever its label says.
            case .system: return "On Tab, you press \(handsOff.label) in the system prompt yourself"
            }
        }
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

    /// "Noticed in Mail, Tue": the app when the helper knows it, then the day. Today and yesterday by
    /// name, the last week by weekday, earlier by date. The window title stays out of the row; it can
    /// name a person or a subject the user did not ask to see here.
    public static func noticedLine(_ n: HelperMemory.Noticed, now: Date, calendar: Calendar, locale: Locale) -> String {
        let date = Date(timeIntervalSince1970: Double(n.at) / 1000)
        let day: String
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) { day = "today" }
        else if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: y) { day = "yesterday" }
        else if let week = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)), date >= week, date <= now {
            day = f.shortWeekdaySymbols[calendar.component(.weekday, from: date) - 1]
        } else {
            f.setLocalizedDateFormatFromTemplate("MMMd")
            day = f.string(from: date)
        }
        return n.app.map { "Noticed in \($0), \(day)" } ?? "Noticed \(day)"
    }

    /// Plain words for a row's status; nil for active, which needs none.
    public static func statusText(_ s: Row.Status) -> String? {
        switch s {
        case .active: return nil
        case .noticed: return "Noticed"
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
        case .onItsOwn: return "Let it run on its own\u{2026}"
        case .keep: return "Keep"
        case .notRight: return "Not right"
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

    // MARK: - Skills on their own, under the rule they write under

    /// One skill on its own, as the permissions page names it under a write rule.
    public struct Exception: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        /// "When a Tracker window opens with Order, Carrier and Tracking empty".
        public var when: String
        public var busy: Bool
        public var problem: String?
    }

    /// The skills on their own whose runs write under one write rule, with words that are true for
    /// that rule's setting.
    public struct Exceptions: Equatable, Sendable {
        public var action: HelperMemory.ActionType
        public var rule: HelperMemory.Rule
        /// False when the setting keeps these skills from starting without Tab under this rule: the
        /// user let them run on their own and then turned the rule down. The page asks the user to
        /// settle it, by the rule or by putting them back on Tab.
        public var runs: Bool
        public var title: String
        public var detail: String
        public var skills: [Exception]
    }

    /// The skills on their own listed under `action`'s row, or nil when there are none (or the action
    /// is not one a skill's run writes under). A skill is listed under each rule its runs wrote under
    /// (`Entry.wrote`). The helper checks the rule each time a run would start (engine.ts), so a skill
    /// listed under a rule whose setting no longer allows it waits for Tab there, and the block says
    /// so. When the helper does not say where a skill wrote, the skill is listed under each rule that
    /// lets it start without Tab now, since any window it fills falls under one of the two.
    public static func exceptions(_ s: MemoryBook.State, under action: HelperMemory.ActionType) -> Exceptions? {
        guard action == .writeHere || action == .writeElsewhere,
              let rule = s.entries.first(where: { $0.permission?.action == action })?.permission?.rule else { return nil }
        let runs = PermissionPolicy.skillRunsUnasked(action, rule)
        let skills = zip(onTheirOwnEntries(s), onTheirOwn(s)).filter { pair, _ in pair.0.wrote.map { $0.contains(action) } ?? runs }.map(\.1)
        guard !skills.isEmpty else { return nil }
        let words = exceptionWords(action, rule, runs: runs)
        return Exceptions(action: action, rule: rule, runs: runs, title: words.title, detail: words.detail, skills: skills)
    }

    /// Every skill that runs on its own and is not paused, in the helper's order.
    public static func onTheirOwn(_ s: MemoryBook.State) -> [Exception] {
        onTheirOwnEntries(s).map { e, f in
            Exception(id: e.id, name: f.name, when: "When \(f.trigger)", busy: s.busy[e.id] != nil || !s.connected || !s.loaded, problem: s.problems[e.id])
        }
    }

    static func onTheirOwnEntries(_ s: MemoryBook.State) -> [(HelperMemory.Entry, SkillFields)] {
        s.entries.compactMap { e in
            guard let f = e.skill, f.onItsOwn, e.status != .paused else { return nil }
            return (e, f)
        }
    }

    /// The block's title and sentence for a write rule at a setting. Only three settings let a skill
    /// start without Tab (`PermissionPolicy.skillRunsUnasked`); at any other the block names the clash.
    public static func exceptionWords(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule, runs: Bool) -> (title: String, detail: String) {
        // A run in the window you're in is drawn at your caret with a ⌘Z toast; one in a window you're
        // not in is left to the perch and the activity list (SurfaceMachine.startUnprompted), whose row
        // has Undo. "Elsewhere" is any window you're not in, the same app's too (engine.ts writeAction).
        let here = action == .writeHere
        guard !runs else {
            let atCaret = "Each run shows at your caret, and ⌘Z undoes it."
            if !here { return ("Skills you approved for other windows", "They change windows you're not in, without Tab. Each run is in Caret's activity list, with Undo.") }
            if rule == .ask { return ("Skills that skip Ask first here", "You let these run on their own, so they fill the window you're in without Tab. \(atCaret)") }
            return ("Skills that run on their own here", "They fill the window you're in without Tab. \(atCaret)")
        }
        let place = here ? "in the window you're in" : "in windows you're not in"
        let held = rule == .handoff ? "Caret leaves them to you" : "they wait for Tab"
        let allowing = here ? "Ask first or Act" : "Act if approved"
        return (
            "Skills this setting holds back",
            "You let these run on their own \(place). At \(ruleTitle(rule)) \(held) there. Choose \(allowing) to let them run, or put them back on Tab."
        )
    }

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
        // B19: a skill earns running on its own here with the promote offer, which Ask first allows.
        case .ask where a == .writeHere: return "Caret offers it, and Tab does it. A skill that keeps getting it right may ask to run on its own."
        case .ask where a == .writeElsewhere: return "Caret offers it, and Tab does it. No skill runs on its own here at this setting."
        case .ask: return "Caret offers it, and Tab does it."
        case .handoff: return "Caret leaves it to you."
        // Only a skill the user let run on its own acts without Tab, and only where skillRunsUnasked allows it.
        case .act, .actIfApproved:
            return PermissionPolicy.skillRunsUnasked(a, r)
                ? "Skills you let run on their own act without Tab. Anything else, Tab still does."
                : "Caret offers it, and Tab does it."
        }
    }

    /// Under the permissions list: the limit no setting moves.
    public static let ceiling = "Sending, deleting, money and passwords never go past Ask first."
    public static let usesNone = "No uses recorded yet."
}
