import CaretScreenCore
import Foundation

// D2-02's routing messages (helper/src/protocol.ts, "routing"; the golden lines are
// helper/fixtures/golden/routing.ndjson, copied byte for byte into the host's test fixtures). The host
// sends routingContext and follows routeDecision (`RouteFollower`, H6) while the user's setting "Caret
// decides when to help" is on; only then does its hello name the `routing` capability.

public enum Routing {
    /// The hello capability that makes the helper send route decisions to this host.
    public static let capability = "routing"
}

/// Host to helper: what only the host knows about the field the user is in.
public struct RoutingContext: Codable, Equatable, Sendable {
    public static let type = "routingContext"

    public enum Selection: String, Codable, Sendable { case caret, range, none }
    public enum Breakpoint: String, Codable, Sendable { case sentence, paragraph }

    public var at: Int64
    public var windowId: String
    public var key: String
    public var selection: Selection
    public var composing: Bool
    /// The host's revision of the field's text and selection, 1 to 64 characters, echoed in each decision.
    public var textRevision: String
    public var breakpoint: Breakpoint?

    public init(at: Int64, windowId: String, key: String, selection: Selection, composing: Bool, textRevision: String, breakpoint: Breakpoint?) {
        self.at = at; self.windowId = windowId; self.key = key; self.selection = selection
        self.composing = composing; self.textRevision = textRevision; self.breakpoint = breakpoint
    }

    enum CodingKeys: String, CodingKey { case type, v, at, windowId, key, selection, composing, textRevision, breakpoint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try RoutingWire.envelope(c, Self.type)
        at = try c.decode(Int64.self, forKey: .at)
        windowId = try RoutingWire.nonEmpty(c, .windowId)
        key = try RoutingWire.nonEmpty(c, .key)
        selection = try c.decode(Selection.self, forKey: .selection)
        composing = try c.decode(Bool.self, forKey: .composing)
        textRevision = try RoutingWire.revision(c, .textRevision)
        breakpoint = try RoutingWire.nullable(c, Breakpoint.self, .breakpoint)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(at, forKey: .at); try c.encode(windowId, forKey: .windowId); try c.encode(key, forKey: .key)
        try c.encode(selection, forKey: .selection); try c.encode(composing, forKey: .composing)
        try c.encode(textRevision, forKey: .textRevision); try c.encode(breakpoint, forKey: .breakpoint)
    }
}

/// Helper to host: the router's decision for one context. A null outcome means a breakpoint ended the
/// last decision and a new one is under way. `error` (R2) means the router failed for this context, and
/// `failure` says how; the host then shows what it shows with no router (`RouteFollower`).
public struct RouteDecision: Codable, Equatable, Sendable {
    public static let type = "routeDecision"

    public enum Outcome: String, Codable, Sendable { case abstain, write, ask, act, error }

    /// protocol.ts's RouteFailure. `failed`: the Jev call or the router's code threw; `timeout`: the
    /// call ran out of time; `missing`, `forged`, `nonfinite`: Jev answered nothing, an option nobody
    /// listed, or a confidence outside 0 to 1; `stale`: the answer came after the context changed.
    public enum Failure: String, Codable, CaseIterable, Sendable { case failed, timeout, missing, forged, nonfinite, stale }

    public var at: Int64
    /// Increasing within one helper process: a lower number is an older decision.
    public var context: Int
    public var windowId: String
    /// The field the decision is about; nil when focus is on no field.
    public var key: String?
    public var textRevision: String
    public var outcome: Outcome?
    /// For `act` only: "fillAll", "workflow:event" and so on.
    public var route: String?
    /// For `error` only, and always there.
    public var failure: Failure?
    public var expires: Int64

    public init(at: Int64, context: Int, windowId: String, key: String?, textRevision: String, outcome: Outcome?, route: String?,
                failure: Failure? = nil, expires: Int64) {
        self.at = at; self.context = context; self.windowId = windowId; self.key = key
        self.textRevision = textRevision; self.outcome = outcome; self.route = route; self.failure = failure; self.expires = expires
    }

    enum CodingKeys: String, CodingKey { case type, v, at, context, windowId, key, textRevision, outcome, route, failure, expires }

    /// Every key, nulls written out, in protocol.ts's order, so a golden line re-encodes to itself.
    /// `failure` is zod's optional: written only on an error decision.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(at, forKey: .at); try c.encode(context, forKey: .context); try c.encode(windowId, forKey: .windowId)
        try c.encode(key, forKey: .key); try c.encode(textRevision, forKey: .textRevision)
        try c.encode(outcome, forKey: .outcome); try c.encode(route, forKey: .route)
        try c.encodeIfPresent(failure, forKey: .failure); try c.encode(expires, forKey: .expires)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try RoutingWire.envelope(c, Self.type)
        at = try c.decode(Int64.self, forKey: .at)
        context = try c.decode(Int.self, forKey: .context)
        guard context > 0 else { throw ProtocolError("routeDecision context must be positive, got \(context)") }
        windowId = try RoutingWire.nonEmpty(c, .windowId)
        key = try RoutingWire.nullable(c, String.self, .key)
        if key?.isEmpty == true { throw ProtocolError("routeDecision key is empty; send null for no field") }
        textRevision = try RoutingWire.revision(c, .textRevision)
        outcome = try RoutingWire.nullable(c, Outcome.self, .outcome)
        route = try RoutingWire.nullable(c, String.self, .route)
        if let route, !(1...80).contains(route.count) { throw ProtocolError("routeDecision route must be 1 to 80 characters") }
        // zod's optional: absent or a known failure, never null.
        failure = try c.decodeIfPresent(Failure.self, forKey: .failure)
        if c.contains(.failure) && failure == nil { throw ProtocolError("routeDecision failure is null; leave it out instead") }
        expires = try c.decode(Int64.self, forKey: .expires)
        if route != nil && outcome != .act { throw ProtocolError("only an act decision names a route") }
        if outcome == .write && key == nil { throw ProtocolError("a write decision names its field") }
        if (outcome == .error) != (failure != nil) { throw ProtocolError("an error decision, and only one, says its failure") }
    }
}

private enum RoutingWire {
    static func envelope<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ type: String) throws {
        let t = try c.decode(String.self, forKey: K(stringValue: "type")!)
        guard t == type else { throw ProtocolError("expected \(type), got \(t)") }
        let v = try c.decode(Int.self, forKey: K(stringValue: "v")!)
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v) for \(type)") }
    }

    static func nonEmpty<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) throws -> String {
        let s = try c.decode(String.self, forKey: k)
        guard !s.isEmpty else { throw ProtocolError("\(k.stringValue) is empty") }
        return s
    }

    static func revision<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) throws -> String {
        let s = try c.decode(String.self, forKey: k)
        guard (1...64).contains(s.count) else { throw ProtocolError("\(k.stringValue) must be 1 to 64 characters") }
        return s
    }

    /// zod's nullable: the key is always present, its value may be null.
    static func nullable<K: CodingKey, T: Decodable>(_ c: KeyedDecodingContainer<K>, _ t: T.Type, _ k: K) throws -> T? {
        guard c.contains(k) else { throw ProtocolError("missing \(k.stringValue); send null instead") }
        return try c.decodeIfPresent(t, forKey: k)
    }
}

/// What Caret knows, Permissions: the setting `CaretSettings.routing` (H6), in the window's words.
public enum RoutingCopy {
    public static let title = "When Caret helps"
    /// What the setting covers: the ambient help the router decides on.
    public static let covers = "Ghost text, writing fixes, and offers by the caret."
    public static let decides = "Caret decides when to help"
    public static let always = "Always suggest as I type"

    public static func choice(_ routing: Bool) -> String { routing ? decides : always }

    /// Under the choice: what it does, in a sentence. The router asks the cloud model (Jev), so the
    /// on choice says so, as the memory window's subtitle does for fill.
    public static func detail(_ routing: Bool) -> String {
        routing
            ? "Each time what you're doing changes, Caret asks its cloud model whether to help, and stays quiet when nothing fits."
            : "Ghost text and offers show as you type, without asking the cloud model first."
    }
}
