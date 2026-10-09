import CaretScreenCore
import Foundation

// B29's Ask questions (helper/src/protocol.ts `askQuestion`, `askAnswer`; golden lines in
// helper/fixtures/golden/ask-choices.ndjson and ask-values.ndjson, copied into the host's test fixtures). A host whose hello
// names `askChoices` may get a question in place of a plan: code listed the real choices for one part
// of the request, and the user's pick goes back as the answer.

/// Helper to the asker: one part of an Ask to settle, with its choices.
public struct AskQuestion: Codable, Equatable, Sendable {
    public static let type = "askQuestion"
    /// Options one question lists at most (protocol.ts MAX_ASK_OPTIONS).
    public static let maxOptions = 8
    /// A task option's label and sentence, at most (protocol.ts MAX_TASK_LABEL, MAX_TASK_SAYS).
    public static let maxTaskLabel = 80
    public static let maxTaskSays = 200
    /// The hello capability for task questions (protocol.ts ASK_TASK_CAPABILITY).
    public static let taskCapability = "askTask"

    /// `task` (slice 1): Jev's route stopped between filling the form and a larger task; each option is one reading.
    public enum Part: String, Codable, Sendable { case fields, source, person, value, task }
    public enum Pick: String, Codable, Sendable { case one, many }

    public enum Option: Codable, Equatable, Sendable {
        case field(id: String, label: String, section: String?)
        case window(id: String, app: String, title: String)
        case memory(id: String)
        case you(id: String)
        case person(id: String, name: String)
        /// A value for a value question's field, exactly as Caret would put it in, and where Caret read it in the user's
        /// words ("Your saved Email", or a window's title and the line).
        case value(id: String, value: String, source: String)
        /// Leave the value question's field blank.
        case blank(id: String)
        /// One reading of the request: a short label ("Fill To and Message") and what Caret then does and leaves to the user.
        case task(id: String, label: String, says: String)

        public var id: String {
            switch self {
            case .field(let id, _, _), .window(let id, _, _), .memory(let id), .you(let id), .person(let id, _), .value(let id, _, _), .blank(let id), .task(let id, _, _):
                return id
            }
        }

        var kind: String {
            switch self {
            case .field: return "field"
            case .window: return "window"
            case .memory: return "memory"
            case .you: return "you"
            case .person: return "person"
            case .value: return "value"
            case .blank: return "blank"
            case .task: return "task"
            }
        }

        enum CodingKeys: String, CodingKey { case kind, id, label, section, app, title, name, value, source, says }

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
            case "value":
                let value = try c.decode(String.self, forKey: .value)
                let source = try c.decode(String.self, forKey: .source)
                guard !value.isEmpty, !source.isEmpty else { throw ProtocolError("a value option needs its value and where it was read") }
                self = .value(id: id, value: value, source: source)
            case "blank": self = .blank(id: id)
            case "task":
                let label = try c.decode(String.self, forKey: .label)
                let says = try c.decode(String.self, forKey: .says)
                guard (1...AskQuestion.maxTaskLabel).contains(label.utf16.count), (1...AskQuestion.maxTaskSays).contains(says.utf16.count) else {
                    throw ProtocolError("a task option's label is 1 to \(AskQuestion.maxTaskLabel) characters and its sentence 1 to \(AskQuestion.maxTaskSays)")
                }
                self = .task(id: id, label: label, says: says)
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
            case .memory, .you, .blank: break
            case .person(_, let name): try c.encode(name, forKey: .name)
            case .value(_, let value, let source): try c.encode(value, forKey: .value); try c.encode(source, forKey: .source)
            case .task(_, let label, let says): try c.encode(label, forKey: .label); try c.encode(says, forKey: .says)
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
    /// G35, on a fields question: the labels of the fields Caret fills whatever is picked. With it, an answer with no
    /// picks fills those alone. On a value question: the values already checked, each as "Label: value", which the
    /// answer leaves as they are.
    public var filling: [String]?
    /// The form the Ask is about.
    public var window: Window
    public var expires: Int64

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, questionId, part, text, pick, options, filling, window, expires }

    /// protocol.ts's superRefine: a fields question picks many fields; a source question picks one
    /// window or memory; a person question picks one of you or a person; a value question picks one of its values, then
    /// one blank, last; ids do not repeat; only a fields or value question names what it is filling, at least one entry,
    /// none empty.
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
        // Absent or a list, never null, as zod reads it.
        filling = c.contains(.filling) ? try c.decode([String].self, forKey: .filling) : nil
        window = try c.decode(Window.self, forKey: .window)
        expires = try c.decode(Int64.self, forKey: .expires)
        guard !questionId.isEmpty, !text.isEmpty else { throw ProtocolError("askQuestion needs a questionId and its text") }
        guard (1...Self.maxOptions).contains(options.count) else { throw ProtocolError("askQuestion lists 1 to \(Self.maxOptions) options") }
        let kinds: Set<String>
        switch part {
        case .fields: kinds = ["field"]
        case .source: kinds = ["window", "memory"]
        case .person: kinds = ["you", "person"]
        case .value: kinds = ["value", "blank"]
        case .task: kinds = ["task"]
        }
        guard pick == (part == .fields ? .many : .one) else { throw ProtocolError("a \(part.rawValue) question picks \(part == .fields ? "many" : "one")") }
        guard options.allSatisfy({ kinds.contains($0.kind) }) else { throw ProtocolError("a \(part.rawValue) question lists only \(kinds.sorted().joined(separator: " or ")) options") }
        if part == .value {
            guard options.count >= 2, options.last?.kind == "blank", options.filter({ $0.kind == "blank" }).count == 1 else {
                throw ProtocolError("a value question lists its values, then one blank")
            }
        }
        if part == .task, options.count < 2 { throw ProtocolError("a task question lists at least two readings") }
        guard Set(options.map(\.id)).count == options.count else { throw ProtocolError("option ids repeat") }
        if let filling {
            guard part == .fields || part == .value else { throw ProtocolError("only a fields or value question names what it is filling") }
            guard !filling.isEmpty, filling.allSatisfy({ !$0.isEmpty }) else { throw ProtocolError("filling names at least one entry, none empty") }
        }
    }

    /// Whether an answer with no picks answers this question: a fields question beside fields Caret fills anyway. A value
    /// question names what it fills too, but its answer is always one pick.
    public var answersWithNoPicks: Bool { part == .fields && filling != nil }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at); try c.encode(questionId, forKey: .questionId)
        try c.encode(part, forKey: .part); try c.encode(text, forKey: .text); try c.encode(pick, forKey: .pick)
        try c.encode(options, forKey: .options); try c.encodeIfPresent(filling, forKey: .filling); try c.encode(window, forKey: .window); try c.encode(expires, forKey: .expires)
    }
}

/// Consumer to helper: the user's pick for a question, by option id, once, before it expires. The
/// reply comes under this `requestId`: a plan, another question, or a `questionGone` refusal. No picks
/// answers only a fields question with `filling`: Caret fills those fields alone. A value question takes one pick.
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
        guard (1...200).contains(requestId.count), !questionId.isEmpty, picks.count <= AskQuestion.maxOptions, picks.allSatisfy({ !$0.isEmpty }) else {
            throw ProtocolError("askAnswer needs a request id, a question id and at most \(AskQuestion.maxOptions) picks")
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
