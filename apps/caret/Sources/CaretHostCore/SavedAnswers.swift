import CaretScreenCore
import Foundation

// Saved answers on the host side (S1; helper/src/protocol.ts "saved answers"; golden
// helper/fixtures/golden/answers.ndjson). A host that names `savedAnswers` in its hello promises two
// things: it shows a saved answer's whole text before inserting it, and it inserts one only on the user's
// own acceptance after that. Only such a host is sent an answer (a fill value with `answer`, a pop-up
// that writes one, an `answerSaveOffer`), and only its `answerSave` counts as the user's consent.

public enum SavedAnswers {
    /// The hello capability (protocol.ts SAVED_ANSWERS_CAPABILITY).
    public static let capability = "savedAnswers"
    /// The pop-up row rule the helper gives a saved answer's value (offers/answer-gate.ts SAVED_ANSWER_RULE).
    public static let rowRule = "savedAnswer"
    /// The longest answer Caret keeps (protocol.ts MAX_ANSWER_CHARS).
    public static let maxChars = 4000
}

/// Helper to host: the user left a prose field on a page form that they typed, and Caret may keep what
/// they wrote. Nothing is saved without the user's yes (`AnswerSave` naming `id`).
public struct AnswerSaveOffer: Codable, Equatable, Sendable {
    public static let type = "answerSaveOffer"

    public var id: String
    public var at: Int64
    public var windowId: String
    public var fieldKey: String
    /// The question as the form asked it.
    public var question: String
    /// The user's words, whole.
    public var answer: String
    public var site: String?
    public var form: String?
    /// The saved answer to the same question on the same site that a yes would update.
    public var replaces: String?
    /// "Save this answer for next time?"
    public var says: String

    public init(id: String, at: Int64, windowId: String, fieldKey: String, question: String, answer: String, site: String?, form: String?, replaces: String?, says: String) {
        self.id = id
        self.at = at
        self.windowId = windowId
        self.fieldKey = fieldKey
        self.question = question
        self.answer = answer
        self.site = site
        self.form = form
        self.replaces = replaces
        self.says = says
    }

    enum CodingKeys: String, CodingKey { case type, v, id, at, windowId, fieldKey, question, answer, site, form, replaces, says }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decode(Int64.self, forKey: .at)
        windowId = try c.decode(String.self, forKey: .windowId)
        fieldKey = try c.decode(String.self, forKey: .fieldKey)
        question = try c.decode(String.self, forKey: .question)
        answer = try c.decode(String.self, forKey: .answer)
        site = try GoalPlans.nullable(String.self, c, .site)
        form = try GoalPlans.nullable(String.self, c, .form)
        replaces = try GoalPlans.nullable(String.self, c, .replaces)
        says = try c.decode(String.self, forKey: .says)
        guard !id.isEmpty, !windowId.isEmpty, !fieldKey.isEmpty, !says.isEmpty else { throw ProtocolError("an answer save offer names itself, its field and its sentence") }
        guard (1...300).contains(question.count), !question.contains(where: \.isNewline) else { throw ProtocolError("a saved answer's question is one line of 1 to 300 characters") }
        guard answer.count <= SavedAnswers.maxChars, !answer.allSatisfy(\.isWhitespace) else { throw ProtocolError("a saved answer is not blank and at most \(SavedAnswers.maxChars) characters") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(windowId, forKey: .windowId); try c.encode(fieldKey, forKey: .fieldKey)
        try c.encode(question, forKey: .question); try c.encode(answer, forKey: .answer); try c.encode(site, forKey: .site); try c.encode(form, forKey: .form)
        try c.encode(replaces, forKey: .replaces); try c.encode(says, forKey: .says)
    }
}

/// Host to helper: the user's consent to save an answer. The host sends only `offer`, the yes to an
/// `AnswerSaveOffer`; `field` ("remember this answer" on a page field) is decoded for the golden's sake.
public struct AnswerSave: Codable, Equatable, Sendable {
    public static let type = "answerSave"

    public enum From: Equatable, Sendable {
        case offer(offerId: String)
        case field(windowId: String, fieldKey: String)
    }

    public var requestId: String
    public var from: From

    public init(requestId: String, from: From) {
        self.requestId = requestId
        self.from = from
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, from }
    enum FromKeys: String, CodingKey { case kind, offerId, windowId, fieldKey }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        let f = try c.nestedContainer(keyedBy: FromKeys.self, forKey: .from)
        switch try f.decode(String.self, forKey: .kind) {
        case "offer": from = .offer(offerId: try f.decode(String.self, forKey: .offerId))
        case "field": from = .field(windowId: try f.decode(String.self, forKey: .windowId), fieldKey: try f.decode(String.self, forKey: .fieldKey))
        case let other: throw ProtocolError("unknown answerSave source \(other)")
        }
        guard !requestId.isEmpty else { throw ProtocolError("answerSave needs a requestId") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v); try c.encode(requestId, forKey: .requestId)
        var f = c.nestedContainer(keyedBy: FromKeys.self, forKey: .from)
        switch from {
        case .offer(let id): try f.encode("offer", forKey: .kind); try f.encode(id, forKey: .offerId)
        case .field(let w, let k): try f.encode("field", forKey: .kind); try f.encode(w, forKey: .windowId); try f.encode(k, forKey: .fieldKey)
        }
    }
}

/// Helper to host: what became of an `AnswerSave`. `says` is the sentence for the user either way.
public struct AnswerSaveReply: Codable, Equatable, Sendable {
    public static let type = "answerSaveReply"

    public enum Outcome: String, Codable, Sendable { case saved, refused }

    public var requestId: String
    public var outcome: Outcome
    public var answerId: String?
    /// The helper's reason code for a refusal (protocol.ts AnswerRefusal); kept as text so a newer one decodes.
    public var why: String?
    public var says: String

    enum CodingKeys: String, CodingKey { case type, v, requestId, outcome, answerId, why, says }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        answerId = try GoalPlans.nullable(String.self, c, .answerId)
        why = try GoalPlans.nullable(String.self, c, .why)
        says = try c.decode(String.self, forKey: .says)
        guard (outcome == .saved) == (answerId != nil), (outcome == .saved) == (why == nil) else {
            throw ProtocolError("a saved reply names the answer and no refusal; a refused one names the refusal and no answer")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(outcome, forKey: .outcome); try c.encode(answerId, forKey: .answerId)
        try c.encode(why, forKey: .why); try c.encode(says, forKey: .says)
    }
}

extension PopupSpec {
    /// A row of this pop-up writes one of the user's saved answers: its value's rule is the helper's
    /// `savedAnswer` (offers/answer-gate.ts). Such a row is drawn whole, never cut to a line.
    public var carriesSavedAnswer: Bool {
        blocks.contains { block in
            guard case .fields(let fields) = block.content else { return false }
            return fields.rows.contains { $0.value.map(SavedAnswers.isSavedAnswer) ?? false }
        }
    }
}

extension SavedAnswers {
    /// The value is a saved answer's, by the rule the helper derived it with.
    public static func isSavedAnswer(_ value: PopupSpec.Value) -> Bool {
        if case .derived(let rule, _) = value.ref { return rule == rowRule }
        return false
    }
}
