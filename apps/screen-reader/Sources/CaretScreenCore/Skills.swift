import Foundation

// B19: the messages about skills, mirroring helper/src/protocol.ts (SkillOffer, SkillAnswer, MemoryReply's
// skill entries). A skill is a routine the user kept; Caret asks once to keep it and, after enough clean
// runs, once to let it run without a Tab.

/// The risk class of a press a skill leaves to the user (helper/src/executor/risk.ts).
public enum PressRisk: String, Codable, Sendable { case outbound, destructive, money }

/// A one-time question at the end of a run that succeeded: keep the routine as a skill, or let a skill run
/// on its own. The host answers with SkillAnswer naming `id`; the helper ends it with offerWithdrawn.
public struct SkillOffer: Codable, Equatable, Sendable {
    public static let type = "skillOffer"
    public enum Kind: String, Codable, Sendable { case keep, promote }
    public struct Action: Codable, Equatable, Sendable {
        public var id: String
        public var label: String
    }
    public var id: String
    public var at: Int64
    public var kind: Kind
    /// The run the question follows; the host shows it with that run's line.
    public var taskId: String
    public var routineId: String
    /// Nil on a keep offer, the skill's id on a promote offer.
    public var skillId: String?
    public var name: String
    public var says: String
    public var detail: String
    /// Accept, then decline, in that order.
    public var actions: [Action]

    enum CodingKeys: String, CodingKey { case id, at, kind, taskId, routineId, skillId, name, says, detail, actions }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Int64.self, forKey: .at)
        kind = try c.decode(Kind.self, forKey: .kind); taskId = try c.decode(String.self, forKey: .taskId)
        routineId = try c.decode(String.self, forKey: .routineId); skillId = try c.decodeNullable(String.self, forKey: .skillId)
        name = try c.decode(String.self, forKey: .name); says = try c.decode(String.self, forKey: .says)
        detail = try c.decode(String.self, forKey: .detail); actions = try c.decode([Action].self, forKey: .actions)
        for (k, v) in [("id", id), ("taskId", taskId), ("routineId", routineId), ("name", name), ("says", says), ("detail", detail)] where v.isEmpty {
            throw ProtocolError("skillOffer \(k) is empty")
        }
        if name.count > 80 { throw ProtocolError("skillOffer name is over 80 characters") }
        if (kind == .keep) != (skillId == nil) { throw ProtocolError("a keep offer has no skillId yet, and a promote offer names one") }
        if skillId?.isEmpty == true { throw ProtocolError("skillOffer skillId is empty") }
        guard actions.map(\.id) == ["accept", "decline"], actions.allSatisfy({ !$0.label.isEmpty }) else {
            throw ProtocolError("skillOffer actions are accept then decline, each with a label")
        }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(kind, forKey: .kind)
        try c.encode(taskId, forKey: .taskId); try c.encode(routineId, forKey: .routineId); try c.encode(skillId, forKey: .skillId)
        try c.encode(name, forKey: .name); try c.encode(says, forKey: .says); try c.encode(detail, forKey: .detail)
        try c.encode(actions, forKey: .actions)
    }
}

/// The user's answer to a skillOffer, by its id.
public struct SkillAnswer: Codable, Equatable, Sendable {
    public static let type = "skillAnswer"
    public enum Answer: String, Codable, Sendable { case accept, decline }
    public var id: String
    public var answer: Answer
    public var at: Int64
    public init(id: String, answer: Answer, at: Int64) {
        self.id = id; self.answer = answer; self.at = at
    }
    enum CodingKeys: String, CodingKey { case id, answer, at }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); answer = try c.decode(Answer.self, forKey: .answer); at = try c.decode(Int64.self, forKey: .at)
        if id.isEmpty { throw ProtocolError("skillAnswer id is empty") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(answer, forKey: .answer); try c.encode(at, forKey: .at)
    }
}

/// A skill entry's fields: what code rendered from the routine's structure, and its run counts.
public struct SkillFields: Codable, Equatable, Sendable {
    public struct HandsOff: Codable, Equatable, Sendable {
        public var label: String
        public var why: PressRisk
    }
    public var routineId: String
    public var name: String
    /// When Caret offers it, as a clause: "a Tracker window opens with Order, Carrier and Tracking empty".
    public var trigger: String
    public var runs: Int
    /// Verified clean runs in a row since the last failure, mismatch, undo or take over.
    public var cleanRuns: Int
    /// Clean runs in a row before Caret offers to run it without a Tab.
    public var needed: Int
    public var onItsOwn: Bool
    /// A press the skill always leaves to the user, such as Send. A skill with one never runs on its own.
    public var handsOff: HandsOff?

    enum CodingKeys: String, CodingKey { case routineId, name, trigger, runs, cleanRuns, needed, onItsOwn, handsOff }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        routineId = try c.decode(String.self, forKey: .routineId); name = try c.decode(String.self, forKey: .name)
        trigger = try c.decode(String.self, forKey: .trigger); runs = try c.decode(Int.self, forKey: .runs)
        cleanRuns = try c.decode(Int.self, forKey: .cleanRuns); needed = try c.decode(Int.self, forKey: .needed)
        onItsOwn = try c.decode(Bool.self, forKey: .onItsOwn); handsOff = try c.decodeNullable(HandsOff.self, forKey: .handsOff)
        if runs < 0 || cleanRuns < 0 || needed < 1 { throw ProtocolError("skill counts are never negative, and it needs at least one clean run") }
        if onItsOwn && handsOff != nil { throw ProtocolError("a skill that hands a press to the user never runs on its own") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(routineId, forKey: .routineId); try c.encode(name, forKey: .name); try c.encode(trigger, forKey: .trigger)
        try c.encode(runs, forKey: .runs); try c.encode(cleanRuns, forKey: .cleanRuns); try c.encode(needed, forKey: .needed)
        try c.encode(onItsOwn, forKey: .onItsOwn); try c.encode(handsOff, forKey: .handsOff)
    }
}

/// One memory entry. Every kind keeps its fields as JSON so a reply round-trips whole; a skill's are also read
/// into `skill`, checked. The host's own memory types (v2/host) read the other kinds.
public struct MemoryEntry: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case about, people, preference, routine, permission, skill }
    public enum Status: String, Codable, Sendable { case learning, active, paused }
    public struct Evidence: Codable, Equatable, Sendable {
        public var count: Int
        public var lastSeen: Int64
        public var app: String?
        enum CodingKeys: String, CodingKey { case count, lastSeen, app }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            count = try c.decode(Int.self, forKey: .count); lastSeen = try c.decode(Int64.self, forKey: .lastSeen)
            app = try c.decodeNullable(String.self, forKey: .app)
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(count, forKey: .count); try c.encode(lastSeen, forKey: .lastSeen); try c.encode(app, forKey: .app)
        }
    }
    public var kind: Kind
    public var id: String
    public var status: Status
    public var says: String
    public var evidence: Evidence
    public var fields: JSON
    /// A permission's last uses, as sent.
    public var uses: JSON?
    /// A skill's fields, read and checked; nil for every other kind.
    public var skill: SkillFields?

    enum CodingKeys: String, CodingKey { case kind, id, status, says, evidence, fields, uses }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind); id = try c.decode(String.self, forKey: .id)
        status = try c.decode(Status.self, forKey: .status); says = try c.decode(String.self, forKey: .says)
        evidence = try c.decode(Evidence.self, forKey: .evidence); fields = try c.decode(JSON.self, forKey: .fields)
        uses = try c.decodeOptional(JSON.self, forKey: .uses)
        skill = kind == .skill ? try c.decode(SkillFields.self, forKey: .fields) : nil
        if let s = skill, (s.onItsOwn ? Status.active : Status.learning) != status, status != .paused {
            throw ProtocolError("skill \(id) is \(status.rawValue), but its fields say \(s.onItsOwn ? "active" : "learning")")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind); try c.encode(id, forKey: .id); try c.encode(status, forKey: .status)
        try c.encode(says, forKey: .says); try c.encode(evidence, forKey: .evidence); try c.encode(fields, forKey: .fields)
        try c.encodeIfPresent(uses, forKey: .uses)
    }
}

/// The helper's answer to a memory request, sent to the asker only.
public struct MemoryReply: Codable, Equatable, Sendable {
    public static let type = "memoryReply"
    public var requestId: String
    /// Nil on success; otherwise what was wrong with the request.
    public var error: String?
    public var entries: [MemoryEntry]
    /// On a list reply only: the ops this helper accepts.
    public var ops: [String]?

    enum CodingKeys: String, CodingKey { case requestId, error, entries, ops }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); error = try c.decodeNullable(String.self, forKey: .error)
        entries = try c.decode([MemoryEntry].self, forKey: .entries); ops = try c.decodeOptional([String].self, forKey: .ops)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId); try c.encode(error, forKey: .error); try c.encode(entries, forKey: .entries)
        try c.encodeIfPresent(ops, forKey: .ops)
    }

    /// The skills in the reply.
    public var skills: [(id: String, status: MemoryEntry.Status, fields: SkillFields)] {
        entries.compactMap { e in e.skill.map { (e.id, e.status, $0) } }
    }
}
