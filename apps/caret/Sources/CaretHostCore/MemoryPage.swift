import Foundation

/// What the memory window shows, computed from `MemoryBook.State`: the four kinds of memory as
/// sections of rows, and the permissions as one row per action type. The window only draws these.
/// Every sentence about an entry is the helper's (`says`); the host adds the evidence line, the
/// status and the controls.
public enum MemoryPage {
    public enum Control: String, Codable, Sendable { case edit, pause, resume, forget }

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
        public var says: String
        /// "Last seen today, 2:14 PM, in Mail". Nil when there is nothing to add.
        public var detail: String?
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

    public static let kinds: [HelperMemory.Kind] = [.about, .people, .preference, .routine]

    public static func title(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "About you"
        case .people: return "People"
        case .preference: return "Preferences"
        case .routine: return "Routines"
        case .permission: return "Permissions"
        }
    }

    static func emptyLine(_ kind: HelperMemory.Kind) -> String {
        switch kind {
        case .about: return "Nothing yet. When you correct a value Caret filled, the right one shows up here."
        case .people: return "Nobody yet. When you write out a name Caret shortened, it remembers who you meant."
        case .preference: return "None yet. When you reformat what Caret filled, the format shows up here."
        case .routine: return "None yet. Steps you repeat between the same apps show up here as Caret learns them."
        case .permission: return ""
        }
    }

    // MARK: - Memory

    public static func sections(_ s: MemoryBook.State, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [Section] {
        kinds.map { kind in
            var rows = s.entries.filter { $0.kind == kind }.map { row($0, s, now: now, calendar: calendar, locale: locale) }
            if kind == .about { rows += s.typed.map(typedRow) }
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
        controls.append(e.status == .paused ? .resume : .pause)
        controls.append(.forget)
        return Row(
            id: e.id, kind: e.kind, says: e.says, detail: evidence(e.evidence, now: now, calendar: calendar, locale: locale),
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
            id: t.id, kind: .about, says: "\(t.label): \(t.value)", detail: "You typed this during setup.",
            status: status, controls: [.forget], busy: false, problem: problem, typed: true
        )
    }

    /// "Last seen today, 2:14 PM, in Mail"; "Last seen Oct 1, in Mail" before yesterday.
    public static func evidence(_ e: HelperMemory.Evidence, now: Date, calendar: Calendar, locale: Locale) -> String? {
        guard e.lastSeen > 0 else { return e.app.map { "In \($0)" } }
        let date = Date(timeIntervalSince1970: Double(e.lastSeen) / 1000)
        let time = DateFormatter()
        time.locale = locale
        time.timeZone = calendar.timeZone
        time.dateStyle = .none
        time.timeStyle = .short
        var when: String
        if calendar.isDate(date, inSameDayAs: now) {
            when = "today, \(time.string(from: date))"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            when = "yesterday, \(time.string(from: date))"
        } else {
            let day = DateFormatter()
            day.locale = locale
            day.timeZone = calendar.timeZone
            day.setLocalizedDateFormatFromTemplate("MMMd")
            when = day.string(from: date)
        }
        if let app = e.app { when += ", in \(app)" }
        return "Last seen \(when)"
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

    public static func controlTitle(_ c: Control) -> String {
        switch c {
        case .edit: return "Edit"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .forget: return "Forget"
        }
    }

    /// The question on a row whose Forget waits for confirmation.
    public static func forgetQuestion(_ kind: HelperMemory.Kind) -> String {
        kind == .routine ? "Forget this routine? Caret won't relearn it for 30 days." : "Forget this? Caret can't bring it back."
    }

    // MARK: - Permissions

    public static func rules(_ s: MemoryBook.State, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> [RuleRow] {
        HelperMemory.ActionType.allCases.compactMap { action in
            guard let e = s.entries.first(where: { $0.permission?.action == action }), let p = e.permission else { return nil }
            let choices = p.fixed ? [] : PermissionPolicy.allowed(action)
            let uses = (e.uses ?? []).prefix(5).map { use -> RuleRow.UseLine in
                let ev = HelperMemory.Evidence(count: 1, lastSeen: use.at, app: nil)
                let when = evidence(ev, now: now, calendar: calendar, locale: locale)?.replacingOccurrences(of: "Last seen ", with: "") ?? ""
                return RuleRow.UseLine(says: use.says, when: when)
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
    /// changes, and only Hand off changes anything there: it holds the offer (helper/src/patterns/
    /// gate.ts, `permissionHandoff`). Nothing yet acts without Tab, so Act and Act if approved say
    /// so rather than promise it; reading and showing do happen without asking.
    public static func ruleDetail(_ a: HelperMemory.ActionType, _ r: HelperMemory.Rule) -> String {
        switch r {
        case .act where a == .read || a == .show: return "Caret does it without asking."
        case .act: return "Meant to happen without asking. For now, Tab still does it."
        case .actIfApproved: return "Meant for routines you approved. For now, Tab still does it."
        case .ask: return "Caret offers it, and Tab does it."
        case .handoff: return "Caret leaves it to you."
        }
    }

    /// Under the permissions list: the limit no setting moves.
    public static let ceiling = "Sending, deleting, money and passwords never go past Ask first."
    public static let usesNone = "No uses recorded yet."
}
