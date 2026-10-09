import CaretScreenCore
import Foundation

extension FigureCharacter: Codable {}

/// What Caret helps with. Onboarding asks for these ("How you want to work") and the menu bar
/// changes them. Each switches a family of generators on or off.
public enum CaretRole: String, Codable, CaseIterable, Sendable {
    /// Grounded fill: a value you would copy from another window into the field you are in.
    case fill
    /// Loops and routines: after the same steps twice, Caret offers the rest.
    case repeats = "repeat"
    /// Pending-state watch: a job or agent thread that finishes or needs you.
    case watch
    /// The event card: a sentence you write with a time in it, offered as an event to add (B16).
    case calendar
    /// Ghost text: the next few words at the caret.
    case words

    /// The generator families this role switches, as the helper names them (`fill`, `loop`,
    /// `routine`, `pending`, `event`) plus the host's own ghost-text engine (`ghost`).
    public var families: [String] {
        switch self {
        case .fill: return ["fill"]
        case .repeats: return ["loop", "routine"]
        case .watch: return ["pending"]
        case .calendar: return ["event"]
        case .words: return ["ghost"]
        }
    }

    /// The row title, in onboarding and the menu bar.
    public var title: String {
        switch self {
        case .fill: return "Fill from other windows"
        case .repeats: return "Finish what you repeat"
        case .watch: return "Watch agent threads"
        // No calendar is named: where events go is still Sam's decision (brief A13).
        case .calendar: return "Add events to a calendar"
        case .words: return "Complete words"
        }
    }

    /// The row's one-line description in onboarding.
    public var detail: String {
        switch self {
        case .fill: return "A value you'd copy from one window into another."
        case .repeats: return "After you do the same steps twice, Caret offers the rest."
        case .watch: return "Tells you when an agent or a job finishes or needs you."
        case .calendar: return "When you write a plan with a time, Caret offers to add it."
        case .words: return "The next few words, faint, for Tab to take."
        }
    }
}

/// How often Caret speaks up. Sets the gate's starting rules per offer kind (`GatePolicy`).
public enum CaretLevel: String, Codable, CaseIterable, Sendable {
    case quiet, balanced, eager

    /// What onboarding and the menu call this choice. "How forward" read as unclear (Sam, A8 brief).
    public static let question = "How often Caret speaks up"

    public var title: String { rawValue.capitalized }

    /// Each level in words, without numbers: the per-hour budgets in `GatePolicy` are assumed.
    public var detail: String {
        switch self {
        case .quiet: return "Rarely, and only with something on screen to point to."
        case .balanced: return "A few times an hour. Routines wait until Caret has seen them."
        case .eager: return "Whenever it can help, with other ways to say a sentence too."
        }
    }
}

/// Everything the user chose: in onboarding, then in the menu bar. Persisted as JSON by the host
/// (`SettingsStore`) and readable over the debug socket (`settings`).
public struct CaretSettings: Codable, Equatable, Sendable {
    /// 2 added the calendar role. A version 1 file was written before that role existed, so it
    /// reads with the role on, as a new user starts; any other version is refused.
    public static let version = 2

    public var version = CaretSettings.version
    /// Every role starts on. Watch in particular: on a real day, Sam went back to unfinished agent
    /// windows 14 times in half an active hour, the most of any role (lead's real-day data, A8
    /// brief; the data itself is not in this repository).
    public var roles: Set<CaretRole> = [.fill, .repeats, .watch, .calendar, .words]
    public var level: CaretLevel = .balanced
    /// The pebble is the default (Sam, 2026-10-02); seed and wren stay as choices in settings.
    public var character: FigureCharacter = .pebble
    /// Nothing is offered while paused, ghost text included.
    public var paused = false
    /// Onboarding reached its end once; it does not open by itself again.
    public var onboarded = false
    /// What the choices say about how the user works, as memory entries (`MemoryEntry`).
    public var memory: [MemoryEntry] = []
    /// "Not on this site" (H5): web origins the user turned Caret off for in What Caret knows, sorted,
    /// each once. The helper's page engines read and act in no frame at these origins.
    public var sitesOff: [String] = []
    /// H6, What Caret knows: "Caret decides when to help" (true) or "Always suggest as I type"
    /// (false, how Caret worked before the router). Off by default, an opt-in: with the router on, the
    /// A5 fixture showed 3 of its 9 wanted offers (evidence/host/h6, offers-routing-c5), and the lead
    /// keeps it off until the router keeps every wanted offer (2026-10-05).
    public var routing = false
    /// H8, What Caret knows: the EventKit identifier of the calendar accepted events go to; nil for the
    /// user's default calendar for new events. The reader reads it from this file (caret-screen
    /// --calendar-user), so the key and its absence for "default" are a contract (CalendarChoiceFile).
    public var eventCalendar: String?
    /// H13, the Sites tab and the quiet line in Gmail: pages with their own suggestions where Caret's inline text is
    /// on, and those whose line the user asked never to see again.
    public var pageInline = PageInlineSettings()
    /// H13: inline text in web page fields, the overall switch. On by default: in text inputs and textareas one ⌘Z
    /// after real typing and Tab removed only the insert on the test Mac, 4 of 4 each (runs/20261006T161320Z-68498).
    /// Contenteditables only with `pageInlineContentEditable` too.
    public var pageInlineText = true
    /// H13: inline text in contenteditable editors as well. Off by default (lead decision after the H13 review,
    /// 2026-10-06): the insert closes Chrome's typing step (extension content/insert.ts closeTyping), and on the test Mac
    /// ⌘Z then removed only the insert, 4 of 4 (runs/20261006T161320Z-68498). But a rich editor (ProseMirror, Lexical,
    /// Draft.js, Notion) keeps its own undo history, whose groups that does not close, so its ⌘Z may still take the
    /// user's typing with the insert. The user can turn it on.
    public var pageInlineContentEditable = false
    /// Which keys take ghost text (brief item 6). Caret's own until Sam picks a default; Cotypist's is
    /// the other preset.
    public var ghostKeys = GhostKeys.caret

    public init() {}

    /// Turns Caret off or back on for one origin; an origin not in `SiteOrigin`'s form changes nothing.
    public mutating func setSite(_ origin: String, off: Bool) {
        guard SiteOrigin.isOrigin(origin) else { return }
        var set = Set(sitesOff)
        if off { set.insert(origin) } else { set.remove(origin) }
        sitesOff = set.sorted()
    }

    enum CodingKeys: String, CodingKey { case version, roles, level, character, paused, onboarded, memory, sitesOff, routing, eventCalendar, pageInline, pageInlineText, pageInlineContentEditable, ghostKeys }

    /// Strict: a file written by a newer host, or a role or level this host does not know, is an
    /// error the caller reports, not a guess.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let written = try c.decode(Int.self, forKey: .version)
        guard written == 1 || written == Self.version else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c, debugDescription: "settings version \(written); this host reads 1 and \(Self.version)")
        }
        version = Self.version
        roles = Set(try c.decode([CaretRole].self, forKey: .roles))
        // Version 1 had no calendar role to turn off, so its absence there is not a choice.
        if written == 1 { roles.insert(.calendar) }
        level = try c.decode(CaretLevel.self, forKey: .level)
        character = try c.decode(FigureCharacter.self, forKey: .character)
        paused = try c.decode(Bool.self, forKey: .paused)
        onboarded = try c.decode(Bool.self, forKey: .onboarded)
        memory = try c.decode([MemoryEntry].self, forKey: .memory)
        // Absent from a file written before H5: no site was turned off. An entry not in origin form
        // is refused with the file, as an unknown role is.
        let sites = try c.decodeIfPresent([String].self, forKey: .sitesOff) ?? []
        if let bad = sites.first(where: { !SiteOrigin.isOrigin($0) }) {
            throw DecodingError.dataCorruptedError(forKey: .sitesOff, in: c, debugDescription: "\(bad) is not a web origin")
        }
        sitesOff = Array(Set(sites)).sorted()
        // Absent from a file written before H6: the default, as for a new user.
        routing = try c.decodeIfPresent(Bool.self, forKey: .routing) ?? false
        // Absent from a file written before H8, or when the user keeps the default.
        eventCalendar = try c.decodeIfPresent(String.self, forKey: .eventCalendar)
        if eventCalendar?.isEmpty == true {
            throw DecodingError.dataCorruptedError(forKey: .eventCalendar, in: c, debugDescription: "eventCalendar is empty; leave it out for the default calendar")
        }
        // Absent from a file written before H13: Caret stays quiet on every page with its own suggestions.
        pageInline = try c.decodeIfPresent(PageInlineSettings.self, forKey: .pageInline) ?? PageInlineSettings()
        // Absent: the defaults, as for a new user.
        pageInlineText = try c.decodeIfPresent(Bool.self, forKey: .pageInlineText) ?? true
        pageInlineContentEditable = try c.decodeIfPresent(Bool.self, forKey: .pageInlineContentEditable) ?? false
        // Absent: the default. A scheme this host does not know is refused with the file.
        ghostKeys = try c.decodeIfPresent(GhostKeys.self, forKey: .ghostKeys) ?? .caret
        let pages = Set(PageField.OwnSuggestions.allCases.map(\.rawValue))
        if let bad = (pageInline.on + pageInline.quiet).first(where: { !pages.contains($0) }) {
            throw DecodingError.dataCorruptedError(forKey: .pageInline, in: c, debugDescription: "\(bad) is not a page with its own suggestions")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        // Sorted, so the file and the socket reply are stable.
        try c.encode(CaretRole.allCases.filter(roles.contains), forKey: .roles)
        try c.encode(level, forKey: .level)
        try c.encode(character, forKey: .character)
        try c.encode(paused, forKey: .paused)
        try c.encode(onboarded, forKey: .onboarded)
        try c.encode(memory, forKey: .memory)
        try c.encode(sitesOff, forKey: .sitesOff)
        try c.encode(routing, forKey: .routing)
        try c.encodeIfPresent(eventCalendar, forKey: .eventCalendar)
        if pageInline != PageInlineSettings() { try c.encode(pageInline, forKey: .pageInline) }
        // Written only when the user changed them, so a later default reaches a user who never did.
        if !pageInlineText { try c.encode(pageInlineText, forKey: .pageInlineText) }
        if pageInlineContentEditable { try c.encode(pageInlineContentEditable, forKey: .pageInlineContentEditable) }
        if ghostKeys != .caret { try c.encode(ghostKeys, forKey: .ghostKeys) }
    }

    public var gate: GatePolicy { GatePolicy(self) }

    /// Rewrites the preference entries from the current choices, stamped `at` and `source`.
    /// Entries of other kinds are left alone.
    public mutating func recordPreferences(source: MemoryEntry.Source, at ms: Int64) {
        let fresh = MemoryEntry.preferences(for: self, source: source, at: ms)
        let previous = Dictionary(memory.filter { $0.kind == .preference }.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        // An unchanged preference keeps its first stamp, so the entry says when it was chosen.
        let merged = fresh.map { entry in previous[entry.key].flatMap { $0.value == entry.value ? $0 : nil } ?? entry }
        memory = memory.filter { $0.kind != .preference } + merged
    }
}

/// One thing Caret knows about the user, shown in memory and editable there. Onboarding writes
/// preferences; the helper's memory store (batch N5) adds the other kinds.
public struct MemoryEntry: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case preference }
    public enum Source: String, Codable, Sendable { case onboarding, menu, socket }

    public var kind: Kind
    /// Stable, such as `role.fill` or `level`.
    public var key: String
    public var value: String
    /// The entry as the memory view reads it: "Help with: Fill from other windows".
    public var says: String
    public var source: Source
    /// Milliseconds since the epoch.
    public var at: Int64

    public init(kind: Kind, key: String, value: String, says: String, source: Source, at: Int64) {
        self.kind = kind
        self.key = key
        self.value = value
        self.says = says
        self.source = source
        self.at = at
    }

    static func preferences(for settings: CaretSettings, source: Source, at ms: Int64) -> [MemoryEntry] {
        var entries = CaretRole.allCases.map { role -> MemoryEntry in
            let on = settings.roles.contains(role)
            return MemoryEntry(
                kind: .preference, key: "role.\(role.rawValue)", value: on ? "on" : "off",
                says: on ? "Help with: \(role.title)" : "No help with: \(role.title)", source: source, at: ms
            )
        }
        entries.append(MemoryEntry(
            kind: .preference, key: "level", value: settings.level.rawValue,
            says: "\(CaretLevel.question): \(settings.level.title)", source: source, at: ms
        ))
        return entries
    }
}

/// The gate's starting rules, from the level and the roles. The helper's gate decides per
/// candidate (rules first); the host enforces what it can decide alone: pause, the words role for
/// its own ghost text, and the fill role for fill proposals (`HostGate`).
///
/// Every number here is assumed, not measured. The offers-per-hour figure for Balanced follows the
/// Fable plan's day-one budget (section 1, "at most 4 offers an hour other than ghost text");
/// Quiet and Eager are a quarter and double of it.
public struct GatePolicy: Codable, Equatable, Sendable {
    public struct Rule: Codable, Equatable, Sendable {
        /// `ghost`, `fill`, `pending`, `loop`, `routine`, `event` or `rewrite`.
        public var family: String
        public var on: Bool
        /// How many times Caret must have seen the pattern before it may offer it. Zero for offers
        /// grounded in what is on screen now, which need no history (Fable plan, section 5,
        /// change 5: Balanced shows grounded offers from day one).
        public var seenBefore: Int

        public init(family: String, on: Bool, seenBefore: Int) {
            self.family = family
            self.on = on
            self.seenBefore = seenBefore
        }
    }

    public var level: CaretLevel
    public var paused: Bool
    /// Offers other than ghost text the helper may show in an hour.
    public var offersPerHour: Int
    public var rules: [Rule]

    public init(_ settings: CaretSettings) {
        level = settings.level
        paused = settings.paused
        let r = Self.levelRules(settings.level)
        offersPerHour = r.perHour
        let enabled = Set(settings.roles.flatMap(\.families))
        rules = r.rules.map { rule in
            var rule = rule
            // Rewrites belong to no role: they come with the words role.
            let family = rule.family == "rewrite" ? "ghost" : rule.family
            rule.on = rule.on && enabled.contains(family) && !settings.paused
            return rule
        }
    }

    public func allows(family: String) -> Bool {
        rules.first { $0.family == family }?.on ?? false
    }

    static func levelRules(_ level: CaretLevel) -> (perHour: Int, rules: [Rule]) {
        switch level {
        case .quiet:
            return (1, [
                Rule(family: "ghost", on: true, seenBefore: 0),
                Rule(family: "fill", on: true, seenBefore: 0),
                Rule(family: "pending", on: true, seenBefore: 0),
                Rule(family: "loop", on: false, seenBefore: 0),
                Rule(family: "routine", on: false, seenBefore: 0),
                // Off at Quiet, as the helper's LEVELS has it (B16): Quiet keeps to what is on
                // screen and asks nothing to be written elsewhere. Assumed, like the helper's.
                Rule(family: "event", on: false, seenBefore: 0),
                Rule(family: "rewrite", on: false, seenBefore: 0),
            ])
        case .balanced:
            return (4, [
                Rule(family: "ghost", on: true, seenBefore: 0),
                Rule(family: "fill", on: true, seenBefore: 0),
                Rule(family: "pending", on: true, seenBefore: 0),
                // A loop is two rounds in this session (plan, section 4); a routine recurs across
                // days, and needs history before it is offered.
                Rule(family: "loop", on: true, seenBefore: 2),
                Rule(family: "routine", on: true, seenBefore: 3),
                Rule(family: "event", on: true, seenBefore: 0),
                Rule(family: "rewrite", on: false, seenBefore: 0),
            ])
        case .eager:
            return (8, [
                Rule(family: "ghost", on: true, seenBefore: 0),
                Rule(family: "fill", on: true, seenBefore: 0),
                Rule(family: "pending", on: true, seenBefore: 0),
                Rule(family: "loop", on: true, seenBefore: 2),
                Rule(family: "routine", on: true, seenBefore: 2),
                Rule(family: "event", on: true, seenBefore: 0),
                Rule(family: "rewrite", on: true, seenBefore: 0),
            ])
        }
    }
}

/// What the host itself refuses, from the settings: everything while paused, its own ghost text
/// without the words role, and fill proposals without the fill role. The other families are the
/// helper's to gate; it gets them in `firstLook` and, once it reads them, in a settings message.
public enum HostGate {
    public static func allowsGhostText(_ settings: CaretSettings) -> Bool {
        settings.gate.allows(family: "ghost")
    }

    /// Whether a helper message may reach the surfaces. Offers whose family the host cannot tell
    /// (alternatives, action lines, pop-ups) are refused only while paused.
    public static func allows(_ message: HelperInbound, _ settings: CaretSettings) -> Bool {
        switch message {
        case .fillProposal: return settings.gate.allows(family: "fill")
        // A keep or promote question is an offer too: paused, Caret asks nothing.
        case .alternatives, .action, .popup, .skillOffer: return !settings.paused
        // S1's offer to keep an answer is an offer too (H11).
        case .answerSaveOffer: return !settings.paused
        // H14: so is the offer to keep a file the user attached.
        case .fileSaveOffer: return !settings.paused
        default: return true
        }
    }
}

extension GateSettings {
    /// What the helper's gate reads from the user's settings (B10's `settings` message): the roles,
    /// in `CaretRole` order, the level and the pause. The character, onboarding and memory stay on
    /// this Mac's side.
    public init(_ settings: CaretSettings, at ms: Int64) {
        let roles = CaretRole.allCases.filter(settings.roles.contains).map { role -> Role in
            switch role {
            case .fill: return .fill
            case .repeats: return .repeat
            case .watch: return .watch
            case .calendar: return .calendar
            case .words: return .words
            }
        }
        let level: Level
        switch settings.level {
        case .quiet: level = .quiet
        case .balanced: level = .balanced
        case .eager: level = .eager
        }
        self.init(at: ms, roles: roles, level: level, paused: settings.paused)
    }

    /// The same roles, level and pause: a change of `at` alone is not a change to send.
    public func sameGate(as other: GateSettings) -> Bool {
        roles == other.roles && level == other.level && paused == other.paused
    }
}
