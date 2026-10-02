// Swift mirror of the offer messages in helper/src/protocol.ts: the helper sends alternatives, action
// lines and pop-ups to the host and withdraws them; the host answers with offerAccept and offerStop.
// Every value, action bar and spec inside them goes through PopupSpec's parsers, so a message the
// helper's zod schema would refuse for a missing ref or a bar without Tab is refused here with the
// same PopupSpecError, not a generic decoding error.
import Foundation

/// The field an offer belongs to. The host matches it by frame, since it cannot recompute the
/// reader's element keys.
public struct OfferField: Codable, Equatable, Sendable {
    public var pid: Int
    public var windowId: String
    /// The reader's element key.
    public var key: String
    public var frame: Frame?
    public init(pid: Int, windowId: String, key: String, frame: Frame?) {
        self.pid = pid; self.windowId = windowId; self.key = key; self.frame = frame
    }
    enum CodingKeys: String, CodingKey { case pid, windowId, key, frame }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pid = try c.decode(Int.self, forKey: .pid); windowId = try c.decode(String.self, forKey: .windowId)
        key = try c.decode(String.self, forKey: .key); frame = try c.decodeNullable(Frame.self, forKey: .frame)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
        try c.encode(key, forKey: .key); try c.encode(frame, forKey: .frame)
    }
}

/// Values for the focused field, best first. The host inserts the one shown itself, so there is no
/// offerAccept for alternatives. `quoted`: the top value is quoted from a source on screen.
public struct OfferAlternatives: Codable, Equatable, Sendable {
    public static let type = "alternatives"
    public static let maxCandidates = 3
    public var offerKey: String
    public var at: Int64
    public var field: OfferField
    public var candidates: [PopupSpec.Value]
    public var quoted: Bool
    public init(offerKey: String, at: Int64, field: OfferField, candidates: [PopupSpec.Value], quoted: Bool) {
        self.offerKey = offerKey; self.at = at; self.field = field; self.candidates = candidates; self.quoted = quoted
    }
    enum CodingKeys: String, CodingKey { case offerKey, at, field, candidates, quoted }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        offerKey = try c.decode(String.self, forKey: .offerKey); at = try c.decode(Int64.self, forKey: .at)
        field = try c.decode(OfferField.self, forKey: .field)
        let raw = try c.decode([JSON].self, forKey: .candidates)
        guard (1...Self.maxCandidates).contains(raw.count) else {
            throw ProtocolError("candidates must hold 1 to \(Self.maxCandidates) values, got \(raw.count)")
        }
        candidates = try raw.enumerated().map { try PopupSpec.parseValue($1, path: "candidates[\($0)]") }
        quoted = try c.decode(Bool.self, forKey: .quoted)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(offerKey, forKey: .offerKey); try c.encode(at, forKey: .at); try c.encode(field, forKey: .field)
        try c.encode(candidates.map(\.json), forKey: .candidates); try c.encode(quoted, forKey: .quoted)
    }
}

/// One action in another app, as a line. `endState` is the work's result in one sentence; `actions`
/// follow the rules of a pop-up's actions block; `variants` is what the down arrow opens.
public struct OfferAction: Codable, Equatable, Sendable {
    public static let type = "action"
    public var offerKey: String
    public var at: Int64
    public var field: OfferField
    /// The app the action happens in, as the line names it.
    public var app: String
    public var endState: PopupSpec.Value
    public var actions: [PopupSpec.Action]
    public var variants: PopupSpec?
    public init(offerKey: String, at: Int64, field: OfferField, app: String, endState: PopupSpec.Value,
                actions: [PopupSpec.Action], variants: PopupSpec? = nil) {
        self.offerKey = offerKey; self.at = at; self.field = field; self.app = app
        self.endState = endState; self.actions = actions; self.variants = variants
    }
    enum CodingKeys: String, CodingKey { case offerKey, at, field, app, endState, actions, variants }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        offerKey = try c.decode(String.self, forKey: .offerKey); at = try c.decode(Int64.self, forKey: .at)
        field = try c.decode(OfferField.self, forKey: .field)
        app = try c.decode(String.self, forKey: .app)
        if app.isEmpty { throw ProtocolError("app is empty") }
        endState = try PopupSpec.parseValue(try c.decode(JSON.self, forKey: .endState), path: "endState")
        actions = try PopupSpec.parseActionBar(try c.decode(JSON.self, forKey: .actions), path: "actions")
        variants = try c.decodeOptional(PopupSpec.self, forKey: .variants)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(offerKey, forKey: .offerKey); try c.encode(at, forKey: .at); try c.encode(field, forKey: .field)
        try c.encode(app, forKey: .app); try c.encode(endState.json, forKey: .endState)
        try c.encode(actions.map(\.json), forKey: .actions); try c.encodeIfPresent(variants, forKey: .variants)
    }
}

/// Help bigger than a sentence: a validated PopupSpec.
public struct OfferPopup: Codable, Equatable, Sendable {
    public static let type = "popup"
    public var offerKey: String
    public var at: Int64
    public var field: OfferField
    public var spec: PopupSpec
    public init(offerKey: String, at: Int64, field: OfferField, spec: PopupSpec) {
        self.offerKey = offerKey; self.at = at; self.field = field; self.spec = spec
    }
    enum CodingKeys: String, CodingKey { case offerKey, at, field, spec }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        offerKey = try c.decode(String.self, forKey: .offerKey); at = try c.decode(Int64.self, forKey: .at)
        field = try c.decode(OfferField.self, forKey: .field); spec = try c.decode(PopupSpec.self, forKey: .spec)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(offerKey, forKey: .offerKey); try c.encode(at, forKey: .at)
        try c.encode(field, forKey: .field); try c.encode(spec, forKey: .spec)
    }
}

/// What the user accepted from an action line or pop-up (Fable plan, section 2, "Hand-off to the
/// executor"). The work runs as a task whose id is `offerId`. Same shape as the host's own type.
public struct OfferAccept: Codable, Equatable, Sendable {
    public static let type = "offerAccept"

    public var offerId: String
    public var actionId: String
    /// Choices the user made before accepting: the highlighted row of a choices block (by block
    /// id, `choices` when it has none, or `variants` for an action line's picker), zero-based.
    public var overrides: [String: Int]
    public var at: Int64

    public init(offerId: String, actionId: String, overrides: [String: Int], at: Int64) {
        self.offerId = offerId
        self.actionId = actionId
        self.overrides = overrides
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case offerId, actionId, overrides, at }

    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        offerId = try c.decode(String.self, forKey: .offerId)
        actionId = try c.decode(String.self, forKey: .actionId)
        overrides = try c.decode([String: Int].self, forKey: .overrides)
        if let (k, row) = overrides.first(where: { $0.value < 0 }) { throw ProtocolError("overrides[\(k)] is negative (\(row))") }
        at = try c.decode(Int64.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(offerId, forKey: .offerId)
        try c.encode(actionId, forKey: .actionId)
        try c.encode(overrides, forKey: .overrides)
        try c.encode(at, forKey: .at)
    }
}

/// Esc on running work: the same as taskControl stop for the task the offer started.
public struct OfferStop: Codable, Equatable, Sendable {
    public static let type = "offerStop"
    public var offerId: String
    public var at: Int64
    public init(offerId: String, at: Int64) { self.offerId = offerId; self.at = at }
    enum CodingKeys: String, CodingKey { case offerId, at }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        offerId = try c.decode(String.self, forKey: .offerId); at = try c.decode(Int64.self, forKey: .at)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(offerId, forKey: .offerId); try c.encode(at, forKey: .at)
    }
}

/// The offer is no longer valid and a consumer removes it. `id` is a patternOffer's id, or the
/// offerKey of an alternatives, action or popup message.
public struct OfferWithdrawn: Codable, Equatable, Sendable {
    public static let type = "offerWithdrawn"
    /// `taken`: its values were entered, by Caret or by the user. `diverged`: the user entered something
    /// else. `idle`: the loop went quiet. `stale`: a window it reads or writes closed, the reader
    /// restarted, or its memory entry was paused or forgotten.
    public enum Reason: String, Codable, Sendable { case taken, dismissed, diverged, idle, stale }
    public var at: Int64
    public var id: String
    public var reason: Reason
    public init(at: Int64, id: String, reason: Reason) { self.at = at; self.id = id; self.reason = reason }
    enum CodingKeys: String, CodingKey { case at, id, reason }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); id = try c.decode(String.self, forKey: .id)
        reason = try c.decode(Reason.self, forKey: .reason)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(id, forKey: .id); try c.encode(reason, forKey: .reason)
    }
}
