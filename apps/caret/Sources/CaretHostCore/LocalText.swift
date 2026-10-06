import CaretScreenCore
import Foundation

// The local-model bridge (L1; helper/src/protocol.ts "the host's local model"; golden
// helper/fixtures/golden/local-model.ndjson). The helper sends `localTextRequest` only to a host whose
// hello names `localModel`, and this host does not name it: its Gemma is KeyType's autocomplete engine,
// with no grammar-constrained generation, and drafts on it are off by design (fast-browser.md, "Text
// model"). A request that arrives anyway is answered `unavailable` at once, so the helper never waits
// out its deadline.

public enum LocalText {
    /// The hello capability (protocol.ts LOCAL_MODEL_CAPABILITY). Not declared until the engine can
    /// serve a request.
    public static let capability = "localModel"

    /// The answer this host gives every request: no model serves it. `model` is empty because none is loaded for it.
    public static func unavailable(_ request: LocalTextRequest) -> LocalTextReply {
        LocalTextReply(id: request.id, outcome: .unavailable, text: nil, model: "", latencyMs: 0)
    }
}

/// Helper to host: words for one field from the host's local model.
public struct LocalTextRequest: Codable, Equatable, Sendable {
    public static let type = "localTextRequest"

    public enum Kind: String, Codable, Sendable { case draft, rewrite }

    public struct Prompt: Codable, Equatable, Sendable {
        public struct Field: Codable, Equatable, Sendable {
            public var name: String
            public var placeholder: String?

            enum CodingKeys: String, CodingKey { case name, placeholder }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                name = try c.decode(String.self, forKey: .name)
                placeholder = try GoalPlans.nullable(String.self, c, .placeholder)
            }

            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(name, forKey: .name); try c.encode(placeholder, forKey: .placeholder)
            }
        }

        public var instruction: String
        public var field: Field
        public var basis: [String]
    }

    public var id: String
    public var kind: Kind
    /// GBNF whose root rule is the only language the text may be in; nil for none.
    public var grammar: String?
    public var prompt: Prompt
    public var maxTokens: Int
    /// Milliseconds since the Unix epoch.
    public var deadlineMs: Int64

    enum CodingKeys: String, CodingKey { case type, v, id, kind, grammar, prompt, maxTokens, deadlineMs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        grammar = try GoalPlans.nullable(String.self, c, .grammar)
        prompt = try c.decode(Prompt.self, forKey: .prompt)
        maxTokens = try c.decode(Int.self, forKey: .maxTokens)
        deadlineMs = try c.decode(Int64.self, forKey: .deadlineMs)
        guard (1...64).contains(id.count) else { throw ProtocolError("a local text request's id is 1 to 64 characters") }
        guard (1...512).contains(maxTokens) else { throw ProtocolError("maxTokens is 1 to 512") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(id, forKey: .id); try c.encode(kind, forKey: .kind); try c.encode(grammar, forKey: .grammar)
        try c.encode(prompt, forKey: .prompt); try c.encode(maxTokens, forKey: .maxTokens); try c.encode(deadlineMs, forKey: .deadlineMs)
    }
}

/// Host to helper: the answer to `localTextRequest` `id`. `text` comes with `ok` and only with it.
public struct LocalTextReply: Codable, Equatable, Sendable {
    public static let type = "localTextReply"

    public enum Outcome: String, Codable, Sendable { case ok, busy, unavailable, timeout, refused }

    public var id: String
    public var outcome: Outcome
    public var text: String?
    /// The model file's name; empty when none is loaded.
    public var model: String
    public var latencyMs: Double

    public init(id: String, outcome: Outcome, text: String?, model: String, latencyMs: Double) {
        self.id = id
        self.outcome = outcome
        self.text = text
        self.model = model
        self.latencyMs = latencyMs
    }

    enum CodingKeys: String, CodingKey { case type, v, id, outcome, text, model, latencyMs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        id = try c.decode(String.self, forKey: .id)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        text = try GoalPlans.nullable(String.self, c, .text)
        model = try c.decode(String.self, forKey: .model)
        latencyMs = try c.decode(Double.self, forKey: .latencyMs)
        guard (outcome == .ok) == (text != nil) else { throw ProtocolError("text comes with outcome ok, and ok needs it") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(id, forKey: .id); try c.encode(outcome, forKey: .outcome); try c.encode(text, forKey: .text)
        try c.encode(model, forKey: .model); try c.encode(latencyMs, forKey: .latencyMs)
    }
}
