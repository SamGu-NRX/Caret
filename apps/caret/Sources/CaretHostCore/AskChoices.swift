import CaretScreenCore
import Foundation

// B29's Ask questions (helper/src/protocol.ts `askQuestion`, `askAnswer`; golden lines in
// helper/fixtures/golden/ask-choices.ndjson, copied into the host's test fixtures). A host whose hello
// names `askChoices` may get a question in place of a plan: code listed the real choices for one part
// of the request, and the user's pick goes back as the answer.

/// Helper to the asker: one part of an Ask to settle, with its choices.
public struct AskQuestion: Codable, Equatable, Sendable {
    public static let type = "askQuestion"
    /// Options one question lists at most (protocol.ts MAX_ASK_OPTIONS).
    public static let maxOptions = 8

    public enum Part: String, Codable, Sendable { case fields, source, person }
    public enum Pick: String, Codable, Sendable { case one, many }

    public enum Option: Codable, Equatable, Sendable {
        case field(id: String, label: String, section: String?)
        case window(id: String, app: String, title: String)
        case memory(id: String)
        case you(id: String)
        case person(id: String, name: String)

        public var id: String {
            switch self {
            case .field(let id, _, _), .window(let id, _, _), .memory(let id), .you(let id), .person(let id, _): return id
            }
        }

        var kind: String {
            switch self {
            case .field: return "field"
            case .window: return "window"
            case .memory: return "memory"
            case .you: return "you"
            case .person: return "person"
            }
        }

        enum CodingKeys: String, CodingKey { case kind, id, label, section, app, title, name }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let id = try c.decode(String.self, forKey: .id)
            guard !id.isEmpty else { throw ProtocolError("an option's id is empty") }
            switch try c.decode(String.self, forKey: .kind) {
            case "field":
                let label = try c.decode(String.self, forKey: .label)
                guard !label.isEmpty else { throw ProtocolError("a field option's label is empty") }
                guard c.contains(.section) else { throw ProtocolError("missing section; send null instead") }
                self = .field(id: id, label: label, section: try c.decodeIfPresent(String.self, forKey: .section))
            case "window": self = .window(id: id, app: try c.decode(String.self, forKey: .app), title: try c.decode(String.self, forKey: .title))
            case "memory": self = .memory(id: id)
            case "you": self = .you(id: id)
            case "person":
                let name = try c.decode(String.self, forKey: .name)
                guard !name.isEmpty else { throw ProtocolError("a person option's name is empty") }
                self = .person(id: id, name: name)
            case let other: throw ProtocolError("unknown option kind \(other)")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(kind, forKey: .kind)
            try c.encode(id, forKey: .id)
            switch self {
            case .field(_, let label, let section): try c.encode(label, forKey: .label); try c.encode(section, forKey: .section)
            case .window(_, let app, let title): try c.encode(app, forKey: .app); try c.encode(title, forKey: .title)
            case .memory, .you: break
            case .person(_, let name): try c.encode(name, forKey: .name)
            }
        }
    }

    public struct Window: Codable, Equatable, Sendable {
        public var pid: Int
        public var windowId: String
        public var appName: String
        public var title: String
    }

    public var requestId: String
    public var at: Int64
    public var questionId: String
    public var part: Part
    /// The question as the user reads it: "Which fields should Caret fill?".
    public var text: String
    public var pick: Pick
    public var options: [Option]
    /// The form the Ask is about.
    public var window: Window
    public var expires: Int64

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, questionId, part, text, pick, options, window, expires }

    /// protocol.ts's superRefine: a fields question picks many fields; a source question picks one
    /// window or memory; a person question picks one of you or a person; ids do not repeat.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        guard type == Self.type else { throw ProtocolError("expected \(Self.type), got \(type)") }
        let v = try c.decode(Int.self, forKey: .v)
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v) for \(type)") }
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        questionId = try c.decode(String.self, forKey: .questionId)
        part = try c.decode(Part.self, forKey: .part)
        text = try c.decode(String.self, forKey: .text)
        pick = try c.decode(Pick.self, forKey: .pick)
        options = try c.decode([Option].self, forKey: .options)
        window = try c.decode(Window.self, forKey: .window)
        expires = try c.decode(Int64.self, forKey: .expires)
        guard !questionId.isEmpty, !text.isEmpty else { throw ProtocolError("askQuestion needs a questionId and its text") }
        guard (1...Self.maxOptions).contains(options.count) else { throw ProtocolError("askQuestion lists 1 to \(Self.maxOptions) options") }
        let kinds: Set<String>
        switch part {
        case .fields: kinds = ["field"]
        case .source: kinds = ["window", "memory"]
        case .person: kinds = ["you", "person"]
        }
        guard pick == (part == .fields ? .many : .one) else { throw ProtocolError("a \(part.rawValue) question picks \(part == .fields ? "many" : "one")") }
        guard options.allSatisfy({ kinds.contains($0.kind) }) else { throw ProtocolError("a \(part.rawValue) question lists only \(kinds.sorted().joined(separator: " or ")) options") }
        guard Set(options.map(\.id)).count == options.count else { throw ProtocolError("option ids repeat") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at); try c.encode(questionId, forKey: .questionId)
        try c.encode(part, forKey: .part); try c.encode(text, forKey: .text); try c.encode(pick, forKey: .pick)
        try c.encode(options, forKey: .options); try c.encode(window, forKey: .window); try c.encode(expires, forKey: .expires)
    }
}

/// Consumer to helper: the user's pick for a question, by option id, once, before it expires. The
/// reply comes under this `requestId`: a plan, another question, or a `questionGone` refusal.
public struct AskAnswer: Codable, Equatable, Sendable {
    public static let type = "askAnswer"

    public var requestId: String
    public var at: Int64
    public var questionId: String
    public var picks: [String]

    public init(requestId: String, at: Int64, questionId: String, picks: [String]) {
        self.requestId = requestId; self.at = at; self.questionId = questionId; self.picks = picks
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, questionId, picks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        guard type == Self.type else { throw ProtocolError("expected \(Self.type), got \(type)") }
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        questionId = try c.decode(String.self, forKey: .questionId)
        picks = try c.decode([String].self, forKey: .picks)
        guard (1...200).contains(requestId.count), !questionId.isEmpty, (1...AskQuestion.maxOptions).contains(picks.count), picks.allSatisfy({ !$0.isEmpty }) else {
            throw ProtocolError("askAnswer needs a request id, a question id and 1 to \(AskQuestion.maxOptions) picks")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at)
        try c.encode(questionId, forKey: .questionId); try c.encode(picks, forKey: .picks)
    }
}

/// Host to helper (D2-04): ⌘1 on a field's fill asks for the whole form in one transaction. The run
/// reports as taskProgress under `proposalId`; a refusal is an error and a stopped taskProgress.
///
/// H10: with `fieldKey`, Tab on one field of a page proposal. The host cannot write a page field
/// (Chrome shows Accessibility no web content), so the helper writes that field alone, as the task
/// `taskID` names.
public struct FillAllRequest: Codable, Equatable, Sendable {
    public static let type = "fillAll"

    public var proposalId: String
    public var at: Int64
    public var fieldKey: String?

    public init(proposalId: String, at: Int64, fieldKey: String? = nil) {
        self.proposalId = proposalId
        self.at = at
        self.fieldKey = fieldKey
    }

    /// The task the helper runs this request as: protocol.ts `fillFieldTask` for one field, else
    /// the proposal's id.
    public var taskID: String { fieldKey.map { Self.fieldTask(proposalId: proposalId, fieldKey: $0) } ?? proposalId }

    /// protocol.ts `fillFieldTask`: the proposal's id, a slash, the field's key.
    public static func fieldTask(proposalId: String, fieldKey: String) -> String { "\(proposalId)/\(fieldKey)" }

    enum CodingKeys: String, CodingKey { case type, v, proposalId, at, fieldKey }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        guard type == Self.type else { throw ProtocolError("expected \(Self.type), got \(type)") }
        proposalId = try c.decode(String.self, forKey: .proposalId)
        guard !proposalId.isEmpty else { throw ProtocolError("fillAll names its proposal") }
        at = try c.decode(Int64.self, forKey: .at)
        fieldKey = try c.decodeIfPresent(String.self, forKey: .fieldKey)
        if fieldKey?.isEmpty == true { throw ProtocolError("fillAll's fieldKey is absent or at least 1 character") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(proposalId, forKey: .proposalId); try c.encode(at, forKey: .at)
        try c.encodeIfPresent(fieldKey, forKey: .fieldKey)
    }
}
