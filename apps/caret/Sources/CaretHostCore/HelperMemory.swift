import CaretScreenCore
import Foundation

// Memory you can see and edit (Fable plan, section 4) and the permission per action type (section 3),
// as the helper serves them: `memoryRequest` from a consumer, `memoryReply` to that consumer only
// (helper/src/protocol.ts MemoryRequest and MemoryReply; the store is helper/src/patterns/memory.ts).
// The screen track's Swift mirror (CaretScreenCore) has no memory types, so the host keeps its own
// here, under `HelperMemory` because `MemoryEntry` already names the host's record of onboarding
// choices (CaretSettings.swift).
//
// Three parts of this file are the host's contract, not yet the helper's
// (`Tests/CaretHostCoreTests/Fixtures/memory.ndjson` has a line of each):
//   - `op: "add"` with `kind: "about"` and `fields: {label, value, source: "typed"}`: a value the user
//     typed in onboarding. The helper's schema refuses the op today ("invalid consumer message").
//   - `ops` on a list reply: the memoryRequest ops this helper accepts. Onboarding shows its "What I
//     know so far" step only when `ops` names `add`, because nothing else keeps what is typed there.
//     Today's helper sends no `ops`, so the step stays hidden.
//   - `uses` on a permission entry: its last five uses, newest first. No helper records uses yet; an
//     entry without the key decodes with `uses == nil`, which the list shows as none recorded.
//   - `op: "edit"` on a skill with `fields: {onItsOwn: false}`: "Put back on Tab" (A15). B19's helper
//     accepts only `name` on a skill and refuses this edit; the host shows that refusal on the row.
//   - `wrote` in a skill's fields: the write permissions its clean runs in a row wrote under
//     (`writeHere`, `writeElsewhere`), which B19's helper keeps in its store (memory.ts SkillJson) and
//     strips from the reply. The permissions page lists a skill under the rules it wrote under; an
//     entry without the key decodes with `wrote == nil` (A16).
//
// Skills (B19) decode through CaretScreenCore's `SkillFields`, which checks them. An entry of a kind this
// host does not know is kept, as `noticed`, and shown by the helper's own sentence: a newer helper's
// memory is never dropped unseen.

public enum HelperMemory {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case about, people, preference, routine, permission, skill
        /// Any kind this host does not know, from a newer helper. Never sent.
        case noticed
    }

    public enum Status: String, Codable, Sendable {
        case learning, active, paused
    }

    /// Plan section 3's action types, in the plan's order.
    public enum ActionType: String, Codable, CaseIterable, Sendable {
        case read, show, writeHere, writeElsewhere, outbound, destructive, sensitive
    }

    /// What Caret may do with an action type, Dots' four rules.
    public enum Rule: String, Codable, CaseIterable, Sendable {
        case act, actIfApproved, ask, handoff

        /// How much Caret does without the user: hand off < ask < act if approved < act.
        public var autonomy: Int {
            switch self {
            case .handoff: return 0
            case .ask: return 1
            case .actIfApproved: return 2
            case .act: return 3
            }
        }
    }

    public struct Evidence: Codable, Equatable, Sendable {
        public var count: Int
        /// Milliseconds since the epoch.
        public var lastSeen: Int64
        public var app: String?

        public init(count: Int, lastSeen: Int64, app: String?) {
            self.count = count
            self.lastSeen = lastSeen
            self.app = app
        }

        enum CodingKeys: String, CodingKey { case count, lastSeen, app }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            count = try c.decode(Int.self, forKey: .count)
            lastSeen = try c.decode(Int64.self, forKey: .lastSeen)
            app = try FirstLookWire.nullable(c, String.self, .app)
        }
    }

    public struct About: Codable, Equatable, Sendable {
        public enum Source: String, Codable, Sendable { case contacts, typed, edit }
        public var label: String
        public var value: String
        public var source: Source

        public init(label: String, value: String, source: Source) {
            self.label = label
            self.value = value
            self.source = source
        }
    }

    public struct People: Codable, Equatable, Sendable {
        public var alias: String
        public var name: String

        public init(alias: String, name: String) {
            self.alias = alias
            self.name = name
        }
    }

    public enum Preference: Equatable, Sendable {
        /// Phone numbers go in this shape; each "#" takes one digit.
        case format(template: String)
        /// A field of this shape gets the About-you entry `aboutId` instead of what it would get.
        case useInstead(field: String, aboutId: String)
        /// Offers of this kind are not made in this app.
        case dontOffer(offerKind: String, appName: String)

        enum CodingKeys: String, CodingKey { case rule, valueKind, template, field, aboutId, offerKind, bundleId, appName }
    }

    public struct Routine: Codable, Equatable, Sendable {
        public struct Silent: Codable, Equatable, Sendable {
            public var hits: Int
            public var misses: Int

            public init(hits: Int, misses: Int) {
                self.hits = hits
                self.misses = misses
            }
        }
        public var srcApps: [String]
        public var dstApp: String
        public var steps: Int
        public var name: String?
        public var silent: Silent

        public init(srcApps: [String], dstApp: String, steps: Int, name: String?, silent: Silent) {
            self.srcApps = srcApps
            self.dstApp = dstApp
            self.steps = steps
            self.name = name
            self.silent = silent
        }

        enum CodingKeys: String, CodingKey { case srcApps, dstApp, steps, name, silent }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            srcApps = try c.decode([String].self, forKey: .srcApps)
            dstApp = try c.decode(String.self, forKey: .dstApp)
            steps = try c.decode(Int.self, forKey: .steps)
            name = try FirstLookWire.nullable(c, String.self, .name)
            silent = try c.decode(Silent.self, forKey: .silent)
        }
    }

    public struct Permission: Codable, Equatable, Sendable {
        public var action: ActionType
        public var rule: Rule
        /// The helper allows only one rule for this action type.
        public var fixed: Bool

        public init(action: ActionType, rule: Rule, fixed: Bool) {
            self.action = action
            self.rule = rule
            self.fixed = fixed
        }
    }

    public enum Fields: Equatable, Sendable {
        case about(About)
        case people(People)
        case preference(Preference)
        case routine(Routine)
        case permission(Permission)
        case skill(SkillFields)
        /// An entry of a kind this host does not know: its wire kind, kept for the debug state. Only
        /// the helper's sentence (`says`) is shown.
        case noticed(kind: String)

        public var kind: Kind {
            switch self {
            case .about: return .about
            case .people: return .people
            case .preference: return .preference
            case .routine: return .routine
            case .permission: return .permission
            case .skill: return .skill
            case .noticed: return .noticed
            }
        }
    }

    /// One use of a permission rule: what Caret did under it. Host contract (see the file header).
    public struct Use: Codable, Equatable, Sendable {
        /// Milliseconds since the epoch.
        public var at: Int64
        /// The use as a sentence, rendered by the helper: "Filled Email in Safari".
        public var says: String
        public var app: String?

        public init(at: Int64, says: String, app: String?) {
            self.at = at
            self.says = says
            self.app = app
        }
    }

    public struct Entry: Equatable, Sendable, Identifiable {
        public var id: String
        public var status: Status
        /// The entry as a sentence, rendered by the helper from its fields.
        public var says: String
        public var evidence: Evidence
        public var fields: Fields
        /// A permission's last five uses, newest first; nil when the helper does not report them.
        public var uses: [Use]?
        /// A skill's write permissions, from its clean runs in a row (host contract, see the file
        /// header): `writeHere`, `writeElsewhere` or both. Nil when the helper does not say.
        public var wrote: Set<ActionType>?

        public var kind: Kind { fields.kind }

        public init(id: String, status: Status, says: String, evidence: Evidence, fields: Fields, uses: [Use]? = nil, wrote: Set<ActionType>? = nil) {
            self.id = id
            self.status = status
            self.says = says
            self.evidence = evidence
            self.fields = fields
            self.uses = uses
            self.wrote = wrote
        }

        public var about: About? { if case .about(let f) = fields { return f } else { return nil } }
        public var permission: Permission? { if case .permission(let f) = fields { return f } else { return nil } }
        public var skill: SkillFields? { if case .skill(let f) = fields { return f } else { return nil } }
    }

    // MARK: - Requests

    /// A field value in an edit or an add: a string, or null (a routine's name cleared).
    public enum FieldValue: Equatable, Sendable, Encodable {
        case text(String)
        case null
        /// A skill's `onItsOwn` (host contract, see the file header).
        case bool(Bool)

        public func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .text(let s): try c.encode(s)
            case .null: try c.encodeNil()
            case .bool(let b): try c.encode(b)
            }
        }
    }

    public struct Request: Encodable, Equatable, Sendable {
        public static let type = "memoryRequest"

        public enum Op: String, Codable, Sendable {
            case list, edit, pause, resume, forget
            /// A value the user typed (see the file header).
            case add
            /// A skill row's "Let it run on its own…" (B22): the helper answers with the skill
            /// unchanged and publishes the normal promote `skillOffer`, whose `taskId` is this
            /// request's id. Running on its own still comes only from accepting that offer.
            case offerOnItsOwn
        }

        public var requestId: String
        public var op: Op
        public var id: String?
        public var kind: Kind?
        public var fields: [String: FieldValue]?

        public init(requestId: String, op: Op, id: String? = nil, kind: Kind? = nil, fields: [String: FieldValue]? = nil) {
            self.requestId = requestId
            self.op = op
            self.id = id
            self.kind = kind
            self.fields = fields
        }

        enum CodingKeys: String, CodingKey { case type, v, requestId, op, id, kind, fields }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(Self.type, forKey: .type)
            try c.encode(Proto.version, forKey: .v)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(op, forKey: .op)
            // Absent, not null: the helper's schema has these as optional, not nullable.
            try c.encodeIfPresent(id, forKey: .id)
            try c.encodeIfPresent(kind, forKey: .kind)
            if let fields {
                // Sorted keys, so a request line is stable for tests and logs.
                var nested = c.nestedContainer(keyedBy: AnyKey.self, forKey: .fields)
                for (key, value) in fields.sorted(by: { $0.key < $1.key }) {
                    try nested.encode(value, forKey: AnyKey(key))
                }
            }
        }

        public func line() throws -> Data { try NDJSON.line(self) }
    }

    // MARK: - Replies

    public struct Reply: Equatable, Sendable {
        public static let type = "memoryReply"

        public var requestId: String
        /// The helper's refusal, in its words; nil on success.
        public var error: String?
        public var entries: [Entry]
        /// Entries this host could not read (a kind or rule from a newer helper), with why. Counted
        /// and reported, never guessed at; the rest of the reply still applies.
        public var unreadable: [String]
        /// The ops the helper says it accepts (host contract, see the file header); nil when it
        /// does not say, as today's helper. Op names this host does not know are left out.
        public var ops: Set<Request.Op>?

        public init(requestId: String, error: String?, entries: [Entry], unreadable: [String] = [], ops: Set<Request.Op>? = nil) {
            self.requestId = requestId
            self.error = error
            self.entries = entries
            self.unreadable = unreadable
            self.ops = ops
        }

        /// The helper said it keeps typed values (`ops` names `add`).
        public var acceptsAdd: Bool { ops?.contains(.add) == true }

        /// The helper offers running on its own when a skill's row asks (`ops` names
        /// `offerOnItsOwn`, B22). An older helper does not, and the row has no such control.
        public var offersOnItsOwn: Bool { ops?.contains(.offerOnItsOwn) == true }

        public static func decode(_ line: Data) throws -> Reply {
            try JSONDecoder().decode(Wire.self, from: line).reply
        }

        private struct Wire: Decodable {
            let reply: Reply

            enum CodingKeys: String, CodingKey { case type, v, requestId, error, entries, ops }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                try FirstLookWire.checkEnvelope(c, Reply.type)
                let lossy = try c.decode([Lossy].self, forKey: .entries)
                let ops = try c.decodeIfPresent([String].self, forKey: .ops)
                reply = Reply(
                    requestId: try c.decode(String.self, forKey: .requestId),
                    error: try FirstLookWire.nullable(c, String.self, .error),
                    entries: lossy.compactMap(\.entry),
                    unreadable: lossy.compactMap(\.problem),
                    ops: ops.map { Set($0.compactMap(Request.Op.init(rawValue:))) }
                )
            }
        }

        /// One entry, or why it could not be read.
        private struct Lossy: Decodable {
            let entry: Entry?
            let problem: String?

            init(from decoder: Decoder) throws {
                do {
                    entry = try Entry(from: decoder)
                    problem = nil
                } catch {
                    entry = nil
                    problem = String(describing: error).prefix(200).description
                }
            }
        }
    }
}

extension HelperMemory.Entry: Decodable {
    enum CodingKeys: String, CodingKey { case kind, id, status, says, evidence, fields, uses }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let wireKind = try c.decode(String.self, forKey: .kind)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(HelperMemory.Status.self, forKey: .status)
        says = try c.decode(String.self, forKey: .says)
        evidence = try c.decode(HelperMemory.Evidence.self, forKey: .evidence)
        // `noticed` is this host's name for kinds it does not know; a helper sending it is one of them.
        let known = HelperMemory.Kind(rawValue: wireKind).flatMap { $0 == .noticed ? nil : $0 }
        switch known {
        case .about: fields = .about(try c.decode(HelperMemory.About.self, forKey: .fields))
        case .people: fields = .people(try c.decode(HelperMemory.People.self, forKey: .fields))
        case .preference: fields = .preference(try c.decode(HelperMemory.Preference.self, forKey: .fields))
        case .routine: fields = .routine(try c.decode(HelperMemory.Routine.self, forKey: .fields))
        case .permission: fields = .permission(try c.decode(HelperMemory.Permission.self, forKey: .fields))
        case .skill:
            let skill = try c.decode(SkillFields.self, forKey: .fields)
            // The helper's rule (protocol.ts MemoryEntry): on its own is active, on Tab is learning, either may be paused.
            if status != .paused, status != (skill.onItsOwn ? .active : .learning) {
                throw ProtocolError("skill \(id) is \(status.rawValue), but its fields say \(skill.onItsOwn ? "active" : "learning")")
            }
            fields = .skill(skill)
            wrote = try Self.wrote(c.nestedContainer(keyedBy: AnyKey.self, forKey: .fields), id: id)
        case .noticed, nil:
            fields = .noticed(kind: wireKind)
        }
        let kind = fields.kind
        // `wrote` belongs to skills; on another known kind it is a helper bug, not something to drop.
        if known != nil, kind != .skill, try c.nestedContainer(keyedBy: AnyKey.self, forKey: .fields).contains(AnyKey("wrote")) {
            throw ProtocolError("wrote on a \(kind.rawValue) entry; only skills have it")
        }
        uses = try c.decodeIfPresent([HelperMemory.Use].self, forKey: .uses)
        if uses != nil, kind != .permission {
            throw ProtocolError("uses on a \(kind.rawValue) entry; only permissions have uses")
        }
    }
}

extension HelperMemory.Entry {
    /// A skill's `wrote` (host contract): only the two write permissions, since a routine run writes
    /// in the window you're in or in another one (helper engine.ts `writeAction`).
    static func wrote(_ fields: KeyedDecodingContainer<AnyKey>, id: String) throws -> Set<HelperMemory.ActionType>? {
        guard let names = try fields.decodeIfPresent([String].self, forKey: AnyKey("wrote")) else { return nil }
        var actions: Set<HelperMemory.ActionType> = []
        for name in names {
            guard let action = HelperMemory.ActionType(rawValue: name), action == .writeHere || action == .writeElsewhere else {
                throw ProtocolError("skill \(id) wrote under '\(name)'; a skill's runs write only under writeHere or writeElsewhere")
            }
            actions.insert(action)
        }
        return actions
    }
}

extension HelperMemory.Preference: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rule = try c.decode(String.self, forKey: .rule)
        switch rule {
        case "format":
            let valueKind = try c.decode(String.self, forKey: .valueKind)
            guard valueKind == "phone" else { throw ProtocolError("format preference for \(valueKind); only phone is known") }
            self = .format(template: try c.decode(String.self, forKey: .template))
        case "useInstead":
            self = .useInstead(field: try c.decode(String.self, forKey: .field), aboutId: try c.decode(String.self, forKey: .aboutId))
        case "dontOffer":
            _ = try c.decode(String.self, forKey: .bundleId)
            self = .dontOffer(offerKind: try c.decode(String.self, forKey: .offerKind), appName: try c.decode(String.self, forKey: .appName))
        default:
            throw ProtocolError("unknown preference rule \(rule)")
        }
    }
}

/// A coding key from a string, for the `fields` object of a request.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

// MARK: - The permission table

/// Which rule each action type may have, mirrored from the helper's table
/// (helper/src/patterns/memory.ts, `PERMISSIONS`, its `allowed` lists; a test reads that file so the
/// two cannot drift). The host uses it only to decide which rules to offer and to refuse a change
/// before sending it; the helper checks every edit again and stays the authority.
public enum PermissionPolicy {
    /// Never past Ask first, whatever the table says (A11 brief): Caret never sends, submits,
    /// deletes or pays on its own.
    public static let neverPastAsk: Set<HelperMemory.ActionType> = [.outbound, .destructive, .sensitive]

    /// The rules an action type may have, least autonomous first.
    public static func allowed(_ action: HelperMemory.ActionType) -> [HelperMemory.Rule] {
        let table: [HelperMemory.Rule]
        switch action {
        case .read, .show: table = [.act]
        case .writeHere: table = [.ask, .act]
        case .writeElsewhere: table = [.ask, .actIfApproved]
        case .outbound, .destructive: table = [.handoff, .ask]
        case .sensitive: table = [.handoff]
        }
        return table.filter { permits(action, $0, table: table) }
    }

    /// Whether the user may set `rule` for `action`.
    public static func permits(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule) -> Bool {
        allowed(action).contains(rule)
    }

    /// Whether a skill the user let run on its own starts without Tab when its run writes under
    /// `action` and that action's rule is `rule`: the helper's `mayRunUnasked` (skills.ts, B19; a test
    /// reads that file). Write where you are allows it at Ask first or Act, since the promote offer
    /// the user accepted is the agreement; Undoable changes in other apps only at Act if approved.
    /// No other action type has skill runs, so none of them allows it.
    public static func skillRunsUnasked(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule) -> Bool {
        switch action {
        case .writeHere: return rule == .ask || rule == .act
        case .writeElsewhere: return rule == .actIfApproved
        case .read, .show, .outbound, .destructive, .sensitive: return false
        }
    }

    private static func permits(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule, table: [HelperMemory.Rule]) -> Bool {
        table.contains(rule) && !(neverPastAsk.contains(action) && rule.autonomy > HelperMemory.Rule.ask.autonomy)
    }
}
