import CaretScreenCore
import Foundation

// D2-02's routing messages (helper/src/protocol.ts, "routing"; golden lines in
// helper/fixtures/golden/routing.ndjson, read by path). The host decodes both and acts on neither: H6
// wires them. Until then the host's hello does not name the `routing` capability, so a helper sends
// it no routeDecision; one that arrives anyway is decoded, checked and counted.

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
/// last decision and a new one is under way.
public struct RouteDecision: Decodable, Equatable, Sendable {
    public static let type = "routeDecision"

    public enum Outcome: String, Decodable, Sendable { case abstain, write, ask, act }

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
    public var expires: Int64

    enum CodingKeys: String, CodingKey { case type, v, at, context, windowId, key, textRevision, outcome, route, expires }

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
        expires = try c.decode(Int64.self, forKey: .expires)
        if route != nil && outcome != .act { throw ProtocolError("only an act decision names a route") }
        if outcome == .write && key == nil { throw ProtocolError("a write decision names its field") }
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
