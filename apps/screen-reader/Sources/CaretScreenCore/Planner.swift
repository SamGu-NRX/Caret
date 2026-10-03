// Swift mirror of the planner's messages in helper/src/protocol.ts: the host asks the helper to plan an
// instruction with planRequest and gets planProposal back, to it only. A proposal is an offer: the plan
// runs only after the host sends offerAccept with its offerKey. The spec goes through PopupSpec's
// parser, so a spec the helper's zod schema refuses is refused here with the same error.
import Foundation

public struct PlanRequest: Codable, Equatable, Sendable {
    public static let type = "planRequest"
    public var requestId: String
    public var at: Int64
    /// What the user asked for, 1 to 500 characters.
    public var instruction: String
    /// The window the user means, when the host knows it.
    public var windowId: String?
    public init(requestId: String, at: Int64, instruction: String, windowId: String? = nil) {
        self.requestId = requestId; self.at = at; self.instruction = instruction; self.windowId = windowId
    }
    enum CodingKeys: String, CodingKey { case requestId, at, instruction, windowId }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); at = try c.decode(Int64.self, forKey: .at)
        instruction = try c.decode(String.self, forKey: .instruction); windowId = try c.decodeOptional(String.self, forKey: .windowId)
        // zod 4 counts a string's length in Unicode code points.
        guard (1...200).contains(requestId.unicodeScalars.count) else { throw ProtocolError("requestId is 1 to 200 characters") }
        guard (1...500).contains(instruction.unicodeScalars.count) else { throw ProtocolError("instruction is 1 to 500 characters") }
        if windowId == "" { throw ProtocolError("windowId is empty; omit it instead") }
        guard at >= 0 else { throw ProtocolError("at is milliseconds since the epoch, never negative") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at)
        try c.encode(instruction, forKey: .instruction); try c.encodeIfPresent(windowId, forKey: .windowId)
    }
}

public struct PlanProposal: Codable, Equatable, Sendable {
    public static let type = "planProposal"
    public enum Outcome: String, Codable, Sendable { case proposed, error }
    /// Why a press is left to the user: its risk class (helper/src/executor/risk.ts), or `unverifiable`
    /// when code cannot predict what it changes.
    public enum HandoffWhy: String, Codable, Sendable { case outbound, destructive, money, unverifiable }
    /// protocol.ts PlanErrorCode has a sentence for each.
    public enum ErrorCode: String, Codable, Sendable {
        case schema, noWindow, unsure, nothingToDo, unsupportedStep, multipleWindows, unknownWindow, ambiguousWindow
        case unknownTarget, ambiguousTarget, notEditable, untracedValue, stepAfterHandoff, riskMismatch, unavailable, jevFailed, privacy, `internal`
    }
    public struct Window: Codable, Equatable, Sendable {
        public var pid: Int
        public var windowId: String
        public var appName: String
        public var title: String
        public init(pid: Int, windowId: String, appName: String, title: String) { self.pid = pid; self.windowId = windowId; self.appName = appName; self.title = title }
    }
    public struct Handoff: Codable, Equatable, Sendable {
        public var label: String
        public var why: HandoffWhy
        public init(label: String, why: HandoffWhy) { self.label = label; self.why = why }
    }
    public struct Failure: Codable, Equatable, Sendable {
        public var code: ErrorCode
        public var detail: String
        public init(code: ErrorCode, detail: String) { self.code = code; self.detail = detail }
    }

    public var requestId: String
    public var at: Int64
    public var outcome: Outcome
    /// offerAccept with this key and the spec's Tab action runs the plan; nil on error.
    public var offerKey: String?
    public var window: Window?
    public var spec: PopupSpec?
    public var handoff: Handoff?
    public var error: Failure?

    public init(requestId: String, at: Int64, outcome: Outcome, offerKey: String?, window: Window?, spec: PopupSpec?, handoff: Handoff?, error: Failure?) throws {
        self.requestId = requestId; self.at = at; self.outcome = outcome; self.offerKey = offerKey
        self.window = window; self.spec = spec; self.handoff = handoff; self.error = error
        if let p = problem { throw ProtocolError(p) }
    }

    /// The helper's refinement, rule for rule: what makes a proposal contradict its outcome, or nil.
    public var problem: String? {
        switch outcome {
        case .proposed:
            if offerKey == nil || window == nil || spec == nil { return "outcome proposed needs offerKey, window and spec" }
            return error == nil ? nil : "outcome proposed carries no error"
        case .error:
            if error == nil { return "outcome error needs error" }
            return offerKey != nil || spec != nil || handoff != nil ? "outcome error carries no offerKey, spec or handoff" : nil
        }
    }

    enum CodingKeys: String, CodingKey { case requestId, at, outcome, offerKey, window, spec, handoff, error }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); at = try c.decode(Int64.self, forKey: .at)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        offerKey = try c.decodeNullable(String.self, forKey: .offerKey)
        if offerKey == "" { throw ProtocolError("offerKey is empty") }
        window = try c.decodeNullable(Window.self, forKey: .window)
        spec = try c.decodeNullable(PopupSpec.self, forKey: .spec)
        handoff = try c.decodeNullable(Handoff.self, forKey: .handoff)
        error = try c.decodeNullable(Failure.self, forKey: .error)
        if let e = error, e.detail.isEmpty { throw ProtocolError("an error says what failed") }
        guard at >= 0 else { throw ProtocolError("at is milliseconds since the epoch, never negative") }
        if let p = problem { throw ProtocolError(p) }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at); try c.encode(outcome, forKey: .outcome)
        try c.encode(offerKey, forKey: .offerKey); try c.encode(window, forKey: .window); try c.encode(spec, forKey: .spec)
        try c.encode(handoff, forKey: .handoff); try c.encode(error, forKey: .error)
    }
}
