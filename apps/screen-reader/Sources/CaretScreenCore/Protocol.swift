// Swift mirror of helper/src/protocol.ts, which is the source of truth.
// Tests decode and re-encode helper/fixtures/golden/protocol.ndjson to keep the two in step.
// Nullable fields are always encoded (as null); optional fields are omitted when absent.
import Foundation

public enum Proto {
    public static let version = 1
}

public struct ProtocolError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

// The zod schemas distinguish nullable fields (key always present, value may be null) from optional
// ones (key may be absent, value never null). Foundation's decoder treats both alike, so these
// helpers enforce the difference and a message zod would reject is rejected here too.
extension KeyedDecodingContainer {
    func decodeNullable<T: Decodable>(_ t: T.Type, forKey k: Key) throws -> T? {
        guard contains(k) else { throw ProtocolError("missing \(k.stringValue); send null instead") }
        return try decodeIfPresent(t, forKey: k)
    }

    func decodeOptional<T: Decodable>(_ t: T.Type, forKey k: Key) throws -> T? {
        guard contains(k) else { return nil }
        if try decodeNil(forKey: k) { throw ProtocolError("\(k.stringValue) is null; omit it instead") }
        return try decode(t, forKey: k)
    }
}

/// [x, y, width, height] in global screen points, top-left origin.
public struct Frame: Codable, Equatable, Hashable, Sendable {
    public var x, y, width, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        x = try c.decode(Double.self); y = try c.decode(Double.self)
        width = try c.decode(Double.self); height = try c.decode(Double.self)
        if !c.isAtEnd { throw ProtocolError("frame has more than four numbers") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(x); try c.encode(y); try c.encode(width); try c.encode(height)
    }
}

public struct AppRef: Codable, Equatable, Hashable, Sendable {
    public var pid: Int
    public var bundleId: String
    public var name: String
    public init(pid: Int, bundleId: String, name: String) {
        self.pid = pid; self.bundleId = bundleId; self.name = name
    }
}

public struct WindowRef: Codable, Equatable, Sendable {
    public var windowId: String
    public var kind: String
    public var title: String
    public var frame: Frame?
    /// The window server's number (CGWindowID); absent when the app gave none.
    public var number: Int?
    public init(windowId: String, kind: String, title: String, frame: Frame?, number: Int? = nil) {
        self.windowId = windowId; self.kind = kind; self.title = title; self.frame = frame; self.number = number
    }
    enum CodingKeys: String, CodingKey { case windowId, kind, title, frame, number }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowId = try c.decode(String.self, forKey: .windowId)
        kind = try c.decode(String.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        frame = try c.decodeNullable(Frame.self, forKey: .frame)
        number = try c.decodeOptional(Int.self, forKey: .number)
        if let n = number, n <= 0 { throw ProtocolError("window number must be positive") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(frame, forKey: .frame)
        try c.encodeIfPresent(number, forKey: .number)
    }
}

public enum NodeState: String, Codable, Hashable, Sendable, CaseIterable {
    case focused, selected, disabled, expanded, checked, secure
}

public struct Node: Codable, Equatable, Hashable, Sendable {
    public var key: String
    public var parent: String?
    public var role: String
    public var subrole: String?
    public var label: String?
    public var value: String?
    public var placeholder: String?
    public var frame: Frame?
    public var editable: Bool
    public var states: [NodeState]

    public init(key: String, parent: String?, role: String, subrole: String? = nil, label: String? = nil,
                value: String? = nil, placeholder: String? = nil, frame: Frame? = nil,
                editable: Bool = false, states: [NodeState] = []) {
        self.key = key; self.parent = parent; self.role = role; self.subrole = subrole
        self.label = label; self.value = value; self.placeholder = placeholder; self.frame = frame
        self.editable = editable; self.states = states
    }

    enum CodingKeys: String, CodingKey { case key, parent, role, subrole, label, value, placeholder, frame, editable, states }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        parent = try c.decodeNullable(String.self, forKey: .parent)
        role = try c.decode(String.self, forKey: .role)
        subrole = try c.decodeOptional(String.self, forKey: .subrole)
        label = try c.decodeOptional(String.self, forKey: .label)
        value = try c.decodeOptional(String.self, forKey: .value)
        placeholder = try c.decodeOptional(String.self, forKey: .placeholder)
        frame = try c.decodeOptional(Frame.self, forKey: .frame)
        let e = try c.decodeOptional(Bool.self, forKey: .editable)
        if e == false { throw ProtocolError("editable is either true or absent") }
        editable = e ?? false
        states = try c.decodeOptional([NodeState].self, forKey: .states) ?? []
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(parent, forKey: .parent)
        try c.encode(role, forKey: .role)
        try c.encodeIfPresent(subrole, forKey: .subrole)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encodeIfPresent(value, forKey: .value)
        try c.encodeIfPresent(placeholder, forKey: .placeholder)
        try c.encodeIfPresent(frame, forKey: .frame)
        if editable { try c.encode(true, forKey: .editable) }
        if !states.isEmpty { try c.encode(states, forKey: .states) }
    }
}

public enum ValueKind: String, Codable, Sendable, CaseIterable {
    case date, time, email, phone, url, address, amount, id
}

public struct TypedValue: Codable, Equatable, Hashable, Sendable {
    public var kind: ValueKind
    public var text: String
    public var nodeKey: String
    public init(kind: ValueKind, text: String, nodeKey: String) {
        self.kind = kind; self.text = text; self.nodeKey = nodeKey
    }
}

public enum WalkReason: String, Codable, Sendable {
    /// `watch`: a re-read of a window under a pending-state watch.
    case initial, focus, event, leave, background, request, watch
}

public enum ClientRole: String, Codable, Sendable { case reader, consumer }
public enum ReaderMode: String, Codable, Sendable { case live, shadow }

/// Every message carries `type` and `v`; this checks both on decode and writes both on encode.
enum Envelope: String, CodingKey { case type, v }

func checkEnvelope(_ decoder: Decoder, _ type: String) throws {
    let c = try decoder.container(keyedBy: Envelope.self)
    let t = try c.decode(String.self, forKey: .type)
    let v = try c.decode(Int.self, forKey: .v)
    guard t == type else { throw ProtocolError("expected type \(type), got \(t)") }
    guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v)") }
}

func writeEnvelope(_ encoder: Encoder, _ type: String) throws {
    var c = encoder.container(keyedBy: Envelope.self)
    try c.encode(type, forKey: .type)
    try c.encode(Proto.version, forKey: .v)
}

public struct Hello: Codable, Equatable, Sendable {
    public static let type = "hello"
    public var role: ClientRole
    public var mode: ReaderMode
    public var pid: Int
    public var version: String
    /// B23: true only in the host app's hello. Only the host's session counts as "host connected".
    public var host: Bool
    /// B23: the reader's launch id, random per process, the same on every reconnect of that process.
    public var session: String?
    /// B23: the reader's challenge for this connection, base64 of 32 random bytes; the helper answers helperAuth.
    public var challenge: String?
    public init(role: ClientRole, mode: ReaderMode, pid: Int, version: String, host: Bool = false, session: String? = nil, challenge: String? = nil) {
        self.role = role; self.mode = mode; self.pid = pid; self.version = version
        self.host = host; self.session = session; self.challenge = challenge
    }
    enum CodingKeys: String, CodingKey { case role, mode, pid, version, host, session, challenge }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(ClientRole.self, forKey: .role)
        mode = try c.decode(ReaderMode.self, forKey: .mode)
        pid = try c.decode(Int.self, forKey: .pid)
        version = try c.decode(String.self, forKey: .version)
        // protocol.ts: host is the literal true or absent, and only a consumer says it.
        switch try c.decodeOptional(Bool.self, forKey: .host) {
        case nil: host = false
        case true?: host = true
        case false?: throw ProtocolError("host is true or absent, never false")
        }
        session = try c.decodeOptional(String.self, forKey: .session)
        challenge = try c.decodeOptional(String.self, forKey: .challenge)
        if host && role != .consumer { throw ProtocolError("only a consumer says host") }
        if (session != nil || challenge != nil) && role != .reader { throw ProtocolError("only the reader sends session and challenge") }
        if let s = session, s.utf16.count < 8 { throw ProtocolError("a session id is at least 8 characters") }
        if let ch = challenge, ch.utf16.count < 16 { throw ProtocolError("a challenge is at least 16 characters") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role); try c.encode(mode, forKey: .mode)
        try c.encode(pid, forKey: .pid); try c.encode(version, forKey: .version)
        if host { try c.encode(true, forKey: .host) }
        try c.encodeIfPresent(session, forKey: .session); try c.encodeIfPresent(challenge, forKey: .challenge)
    }
}

/// B23: the helper's answer to the reader's hello challenge, first on the connection: base64 of
/// HMAC-SHA256(launch secret, "caret-helper-proof\n" + challenge + "\n" + pid), `pid` being the helper's own
/// process, which the reader checks against its socket's peer. HelperProof checks the rest.
public struct HelperAuth: Codable, Equatable, Sendable {
    public static let type = "helperAuth"
    public var proof: String
    public var pid: Int
    public init(proof: String, pid: Int) { self.proof = proof; self.pid = pid }
    enum CodingKeys: String, CodingKey { case proof, pid }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proof = try c.decode(String.self, forKey: .proof); pid = try c.decode(Int.self, forKey: .pid)
        if proof.isEmpty { throw ProtocolError("a proof is not empty") }
        if pid <= 0 { throw ProtocolError("a proof names the helper's pid") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(proof, forKey: .proof); try c.encode(pid, forKey: .pid)
    }
}

public struct WalkStats: Codable, Equatable, Sendable {
    public var walkMs: Double
    public var visited: Int
    public var truncated: Bool
    public init(walkMs: Double, visited: Int, truncated: Bool) {
        self.walkMs = walkMs; self.visited = visited; self.truncated = truncated
    }
}

public struct Snapshot: Codable, Equatable, Sendable {
    public static let type = "snapshot"
    public var seq: Int
    public var at: Int64
    public var reason: WalkReason
    public var app: AppRef
    public var window: WindowRef
    public var focused: Bool
    public var root: String?
    public var nodes: [Node]
    public var values: [TypedValue]
    public var focusedKey: String?
    public var stats: WalkStats

    public init(seq: Int, at: Int64, reason: WalkReason, app: AppRef, window: WindowRef, focused: Bool, root: String?,
                nodes: [Node], values: [TypedValue], focusedKey: String?, stats: WalkStats) {
        self.seq = seq; self.at = at; self.reason = reason; self.app = app; self.window = window
        self.focused = focused; self.root = root; self.nodes = nodes; self.values = values
        self.focusedKey = focusedKey; self.stats = stats
    }
    enum CodingKeys: String, CodingKey { case seq, at, reason, app, window, focused, root, nodes, values, focusedKey, stats }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        at = try c.decode(Int64.self, forKey: .at)
        reason = try c.decode(WalkReason.self, forKey: .reason)
        app = try c.decode(AppRef.self, forKey: .app)
        window = try c.decode(WindowRef.self, forKey: .window)
        focused = try c.decode(Bool.self, forKey: .focused)
        root = try c.decodeNullable(String.self, forKey: .root)
        nodes = try c.decode([Node].self, forKey: .nodes)
        values = try c.decode([TypedValue].self, forKey: .values)
        focusedKey = try c.decodeNullable(String.self, forKey: .focusedKey)
        stats = try c.decode(WalkStats.self, forKey: .stats)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(seq, forKey: .seq); try c.encode(at, forKey: .at); try c.encode(reason, forKey: .reason)
        try c.encode(app, forKey: .app); try c.encode(window, forKey: .window); try c.encode(focused, forKey: .focused)
        try c.encode(root, forKey: .root); try c.encode(nodes, forKey: .nodes); try c.encode(values, forKey: .values)
        try c.encode(focusedKey, forKey: .focusedKey); try c.encode(stats, forKey: .stats)
    }
}

public struct Focus: Codable, Equatable, Sendable {
    public static let type = "focus"
    public var at: Int64
    public var app: AppRef
    public var windowId: String
    public var key: String?
    public var role: String
    public var editable: Bool
    public var empty: Bool
    public var frontmost: Bool
    public init(at: Int64, app: AppRef, windowId: String, key: String?, role: String, editable: Bool, empty: Bool, frontmost: Bool) {
        self.at = at; self.app = app; self.windowId = windowId; self.key = key; self.role = role
        self.editable = editable; self.empty = empty; self.frontmost = frontmost
    }
    enum CodingKeys: String, CodingKey { case at, app, windowId, key, role, editable, empty, frontmost }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); app = try c.decode(AppRef.self, forKey: .app)
        windowId = try c.decode(String.self, forKey: .windowId); key = try c.decodeNullable(String.self, forKey: .key)
        role = try c.decode(String.self, forKey: .role); editable = try c.decode(Bool.self, forKey: .editable)
        empty = try c.decode(Bool.self, forKey: .empty); frontmost = try c.decode(Bool.self, forKey: .frontmost)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(app, forKey: .app); try c.encode(windowId, forKey: .windowId)
        try c.encode(key, forKey: .key); try c.encode(role, forKey: .role); try c.encode(editable, forKey: .editable)
        try c.encode(empty, forKey: .empty); try c.encode(frontmost, forKey: .frontmost)
    }
}

public struct AppSwitch: Codable, Equatable, Sendable {
    public static let type = "appSwitch"
    public var at: Int64
    public var from: AppRef?
    public var to: AppRef
    public init(at: Int64, from: AppRef?, to: AppRef) { self.at = at; self.from = from; self.to = to }
    enum CodingKeys: String, CodingKey { case at, from, to }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at)
        from = try c.decodeNullable(AppRef.self, forKey: .from)
        to = try c.decode(AppRef.self, forKey: .to)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(from, forKey: .from); try c.encode(to, forKey: .to)
    }
}

public struct WindowClosed: Codable, Equatable, Sendable {
    public static let type = "windowClosed"
    public var at: Int64
    public var windowId: String
    public init(at: Int64, windowId: String) { self.at = at; self.windowId = windowId }
    enum CodingKeys: String, CodingKey { case at, windowId }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); windowId = try c.decode(String.self, forKey: .windowId)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(windowId, forKey: .windowId)
    }
}

public struct Pasteboard: Codable, Equatable, Sendable {
    public static let type = "pasteboard"
    public var at: Int64
    public var changeCount: Int
    public init(at: Int64, changeCount: Int) { self.at = at; self.changeCount = changeCount }
    enum CodingKeys: String, CodingKey { case at, changeCount }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); changeCount = try c.decode(Int.self, forKey: .changeCount)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(changeCount, forKey: .changeCount)
    }
}

public struct FillRequest: Codable, Equatable, Sendable {
    public static let type = "fillRequest"
    public var windowId: String
    public var fieldKey: String
    public init(windowId: String, fieldKey: String) { self.windowId = windowId; self.fieldKey = fieldKey }
    enum CodingKeys: String, CodingKey { case windowId, fieldKey }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowId = try c.decode(String.self, forKey: .windowId); fieldKey = try c.decode(String.self, forKey: .fieldKey)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId); try c.encode(fieldKey, forKey: .fieldKey)
    }
}

public struct FillSource: Codable, Equatable, Sendable {
    public var pid: Int
    public var windowId: String
    public var bundleId: String
    public var appName: String
    public var windowTitle: String
    public var nodeKey: String
    public var kind: ValueKind?
    enum CodingKeys: String, CodingKey { case pid, windowId, bundleId, appName, windowTitle, nodeKey, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pid = try c.decode(Int.self, forKey: .pid)
        windowId = try c.decode(String.self, forKey: .windowId); bundleId = try c.decode(String.self, forKey: .bundleId)
        appName = try c.decode(String.self, forKey: .appName); windowTitle = try c.decode(String.self, forKey: .windowTitle)
        nodeKey = try c.decode(String.self, forKey: .nodeKey); kind = try c.decodeNullable(ValueKind.self, forKey: .kind)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pid, forKey: .pid)
        try c.encode(windowId, forKey: .windowId); try c.encode(bundleId, forKey: .bundleId)
        try c.encode(appName, forKey: .appName); try c.encode(windowTitle, forKey: .windowTitle)
        try c.encode(nodeKey, forKey: .nodeKey); try c.encode(kind, forKey: .kind)
    }
}

/// One of the two independent asks behind a fill, with ids mapped back to the first ask's numbering.
public struct FillAsk: Codable, Equatable, Sendable {
    public var choice: String
    public var confidence: Double
    public var value: String?
    enum CodingKeys: String, CodingKey { case choice, confidence, value }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        choice = try c.decode(String.self, forKey: .choice); confidence = try c.decode(Double.self, forKey: .confidence)
        value = try c.decodeNullable(String.self, forKey: .value)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(choice, forKey: .choice); try c.encode(confidence, forKey: .confidence); try c.encode(value, forKey: .value)
    }
}

/// Why no value was proposed: the asks disagreed, agreed below the cutoff, or a window's privacy budget
/// cut a value of the field's kind, so the field was not asked or its pick not proposed. A value from
/// memory is also `lowConfidence` when the asks did not both say the field wants the user's own details (B18).
public enum FillWithheld: String, Codable, Sendable { case disagree, lowConfidence, sourceCut }

/// A value that came from memory rather than a window: an About entry the user typed into Caret (B17).
/// `says` is the source line after "from": "what you told Caret".
public struct FillMemory: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var says: String
    public init(id: String, label: String, says: String) {
        self.id = id
        self.label = label
        self.says = says
    }
}

public struct FillField: Codable, Equatable, Sendable {
    public var key: String
    public var frame: Frame?
    public var descriptor: String
    public var choice: String
    public var confidence: Double
    /// The chosen candidate's text, copied verbatim by the helper. Nil when the choice is "none".
    public var value: String?
    public var source: FillSource?
    /// The memory entry the value came from, when it came from one. A value has exactly one of `source`
    /// and `memory`. Read with decodeIfPresent, so a line from a helper before B17 still decodes.
    public var memory: FillMemory?
    public var withheld: FillWithheld?
    /// Two: the first ask, and the second with candidates shuffled and the field reworded. None when the
    /// field was not asked (withheld as sourceCut, or nothing could be offered for it).
    public var asks: [FillAsk]
    enum CodingKeys: String, CodingKey { case key, frame, descriptor, choice, confidence, value, source, memory, withheld, asks }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key); frame = try c.decodeNullable(Frame.self, forKey: .frame)
        descriptor = try c.decode(String.self, forKey: .descriptor); choice = try c.decode(String.self, forKey: .choice)
        confidence = try c.decode(Double.self, forKey: .confidence)
        value = try c.decodeNullable(String.self, forKey: .value); source = try c.decodeNullable(FillSource.self, forKey: .source)
        memory = try c.decodeIfPresent(FillMemory.self, forKey: .memory)
        withheld = try c.decodeNullable(FillWithheld.self, forKey: .withheld)
        asks = try c.decode([FillAsk].self, forKey: .asks)
        if asks.count != 2 && asks.count != 0 { throw ProtocolError("asks must hold two entries or none, got \(asks.count)") }
        if source != nil && memory != nil { throw ProtocolError("a fill value comes from a window or from memory, not both") }
        if (value == nil) != (source == nil && memory == nil) { throw ProtocolError("a fill value needs its source or memory entry, and neither comes without a value") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key); try c.encode(frame, forKey: .frame); try c.encode(descriptor, forKey: .descriptor)
        try c.encode(choice, forKey: .choice); try c.encode(confidence, forKey: .confidence)
        try c.encode(value, forKey: .value); try c.encode(source, forKey: .source); try c.encode(memory, forKey: .memory)
        try c.encode(withheld, forKey: .withheld); try c.encode(asks, forKey: .asks)
    }
}

public struct JevUsage: Codable, Equatable, Sendable {
    public var model: String
    public var latencyMs: Double
    public var inputTokens: Int
    public var costUsd: Double
}

public struct FillProposal: Codable, Equatable, Sendable {
    public static let type = "fillProposal"
    public var id: String
    public var at: Int64
    /// The process that owns the form's window.
    public var pid: Int
    public var windowId: String
    public var bundleId: String
    public var triggerKey: String
    public var fields: [FillField]
    public var candidates: Int
    public var jev: JevUsage
    /// The confidence an agreed choice of a window's value had to reach to be proposed. A value from
    /// memory is held to helper/src/fill/fill.ts MEMORY_CUTOFF and WHOSE_CUTOFF instead (B18).
    public var cutoff: Double
    enum CodingKeys: String, CodingKey { case id, at, pid, windowId, bundleId, triggerKey, fields, candidates, jev, cutoff }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Int64.self, forKey: .at)
        pid = try c.decode(Int.self, forKey: .pid)
        windowId = try c.decode(String.self, forKey: .windowId); bundleId = try c.decode(String.self, forKey: .bundleId)
        triggerKey = try c.decode(String.self, forKey: .triggerKey); fields = try c.decode([FillField].self, forKey: .fields)
        candidates = try c.decode(Int.self, forKey: .candidates); jev = try c.decode(JevUsage.self, forKey: .jev)
        cutoff = try c.decode(Double.self, forKey: .cutoff)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(pid, forKey: .pid)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(bundleId, forKey: .bundleId); try c.encode(triggerKey, forKey: .triggerKey)
        try c.encode(fields, forKey: .fields); try c.encode(candidates, forKey: .candidates); try c.encode(jev, forKey: .jev)
        try c.encode(cutoff, forKey: .cutoff)
    }
}

public struct HelperError: Codable, Equatable, Sendable {
    public static let type = "error"
    public var at: Int64
    public var message: String
    enum CodingKeys: String, CodingKey { case at, message }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); message = try c.decode(String.self, forKey: .message)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(message, forKey: .message)
    }
}

// MARK: - executor messages

/// What the helper asks the reader to do. Mirrors ReaderCommand.verb in protocol.ts.
public enum ReaderVerb: Codable, Equatable, Sendable {
    case walk(pid: Int, windowId: String)
    /// `attribute` is "value", "focused", "focusValue" (focus, then the value: B20's WebKit write) or "insert"
    /// (focus, select all, replace the selection); `expect` is
    /// the value the field must hold right before the write.
    /// `taskId` names the task whose act grant covers the write; nil acts only in --act-pids processes.
    /// `element` (B23, S1 audit #6): `.mark` records the element written under the helper's name; `.sameAs` requires
    /// the element at `key` to be the one recorded under it.
    case write(pid: Int, windowId: String, key: String, role: String, attribute: String, expect: String, value: String, taskId: String?, element: ElementIdentity? = nil)
    /// `label` is the label the element must still carry.
    case press(pid: Int, windowId: String, key: String, role: String, label: String, taskId: String?)
    case watchInput(pids: [Int])
    /// Replaces the set of windows under a pending-state watch; an empty list ends every watch.
    case watchWindows(windows: [WatchedWindow])
    /// B20: replaces the set of windows whose user presses the reader reports as userPress. Read only; an
    /// empty list stops reporting.
    case watchPresses(windows: [WatchedWindow])
    /// Brings one window to the front and activates its app, then re-walks it. It writes nothing, but
    /// it moves the user's focus, so it is gated like write and press.
    case raise(pid: Int, windowId: String, taskId: String?)
    /// The calendar verbs (B16) go to CalendarAdapter, only with --calendar-test. Times are ISO 8601 with
    /// offset. The writes name their task, whose calendar grant the reader checks right before writing.
    case calendarFind(calendar: String, title: String, start: String, end: String)
    case calendarAdd(calendar: String, title: String, start: String, end: String, taskId: String)
    case calendarGet(id: String)
    case calendarRemove(id: String, taskId: String)
    case calendarDispose(calendar: String, taskId: String)

    enum CodingKeys: String, CodingKey { case kind, pid, windowId, key, role, attribute, expect, value, label, pids, windows, taskId, calendar, title, start, end, id, mark, sameAs }

    /// True for the verbs that go to the calendar adapter rather than an app's window.
    public var isCalendar: Bool {
        switch self {
        case .calendarFind, .calendarAdd, .calendarGet, .calendarRemove, .calendarDispose: true
        default: false
        }
    }

    /// The task an acting verb names, checked against the reader's act grants.
    public var taskId: String? {
        switch self {
        case let .write(_, _, _, _, _, _, _, t, _), let .press(_, _, _, _, _, t), let .raise(_, _, t): t
        case let .calendarAdd(_, _, _, _, t), let .calendarRemove(_, t), let .calendarDispose(_, t): t
        case .walk, .watchInput, .watchWindows, .watchPresses, .calendarFind, .calendarGet: nil
        }
    }

    /// A calendar write names its task: required and non-empty, as protocol.ts requires.
    private static func calendarTask(_ c: KeyedDecodingContainer<CodingKeys>) throws -> String {
        let t = try c.decode(String.self, forKey: .taskId)
        if t.isEmpty { throw ProtocolError("a calendar write names its task") }
        return t
    }

    /// An empty task id is refused, as zod's min(1) refuses it.
    private static func grantTask(_ c: KeyedDecodingContainer<CodingKeys>) throws -> String? {
        let t = try c.decodeOptional(String.self, forKey: .taskId)
        if t == "" { throw ProtocolError("taskId is empty; omit it instead") }
        return t
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "walk":
            self = .walk(pid: try c.decode(Int.self, forKey: .pid), windowId: try c.decode(String.self, forKey: .windowId))
        case "write":
            let attribute = try c.decode(String.self, forKey: .attribute)
            guard ["value", "focused", "focusValue", "insert"].contains(attribute) else { throw ProtocolError("unknown write attribute \(attribute)") }
            let mark = try c.decodeOptional(String.self, forKey: .mark), sameAs = try c.decodeOptional(String.self, forKey: .sameAs)
            if mark == "" || sameAs == "" { throw ProtocolError("a mark is not empty; omit it instead") }
            if mark != nil && sameAs != nil { throw ProtocolError("a write records a mark or checks one, not both") }
            self = .write(pid: try c.decode(Int.self, forKey: .pid), windowId: try c.decode(String.self, forKey: .windowId),
                          key: try c.decode(String.self, forKey: .key), role: try c.decode(String.self, forKey: .role),
                          attribute: attribute, expect: try c.decode(String.self, forKey: .expect), value: try c.decode(String.self, forKey: .value),
                          taskId: try Self.grantTask(c), element: mark.map(ElementIdentity.mark) ?? sameAs.map(ElementIdentity.sameAs))
        case "press":
            self = .press(pid: try c.decode(Int.self, forKey: .pid), windowId: try c.decode(String.self, forKey: .windowId),
                          key: try c.decode(String.self, forKey: .key), role: try c.decode(String.self, forKey: .role),
                          label: try c.decode(String.self, forKey: .label), taskId: try Self.grantTask(c))
        case "watchInput":
            self = .watchInput(pids: try c.decode([Int].self, forKey: .pids))
        case "watchWindows":
            self = .watchWindows(windows: try c.decode([WatchedWindow].self, forKey: .windows))
        case "watchPresses":
            self = .watchPresses(windows: try c.decode([WatchedWindow].self, forKey: .windows))
        case "raise":
            self = .raise(pid: try c.decode(Int.self, forKey: .pid), windowId: try c.decode(String.self, forKey: .windowId), taskId: try Self.grantTask(c))
        case "calendarFind", "calendarAdd":
            let calendar = try c.decode(String.self, forKey: .calendar)
            if calendar.isEmpty { throw ProtocolError("a calendar verb names its calendar") }
            let start = try c.decode(String.self, forKey: .start), end = try c.decode(String.self, forKey: .end)
            guard CalendarTime.parse(start) != nil, CalendarTime.parse(end) != nil else { throw ProtocolError("start and end are ISO 8601 times with an offset") }
            let title = try c.decode(String.self, forKey: .title)
            self = try c.decode(String.self, forKey: .kind) == "calendarFind"
                ? .calendarFind(calendar: calendar, title: title, start: start, end: end)
                : .calendarAdd(calendar: calendar, title: title, start: start, end: end, taskId: try Self.calendarTask(c))
        case "calendarGet", "calendarRemove":
            let id = try c.decode(String.self, forKey: .id)
            if id.isEmpty { throw ProtocolError("a calendar verb names its event") }
            self = try c.decode(String.self, forKey: .kind) == "calendarGet" ? .calendarGet(id: id) : .calendarRemove(id: id, taskId: try Self.calendarTask(c))
        case "calendarDispose":
            let calendar = try c.decode(String.self, forKey: .calendar)
            if calendar.isEmpty { throw ProtocolError("a calendar verb names its calendar") }
            self = .calendarDispose(calendar: calendar, taskId: try Self.calendarTask(c))
        case let k:
            throw ProtocolError("unknown verb \(k)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .walk(pid, windowId):
            try c.encode("walk", forKey: .kind); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
        case let .write(pid, windowId, key, role, attribute, expect, value, taskId, element):
            try c.encode("write", forKey: .kind); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
            try c.encode(key, forKey: .key); try c.encode(role, forKey: .role); try c.encode(attribute, forKey: .attribute)
            try c.encode(expect, forKey: .expect); try c.encode(value, forKey: .value); try c.encodeIfPresent(taskId, forKey: .taskId)
            switch element {
            case .mark(let m)?: try c.encode(m, forKey: .mark)
            case .sameAs(let m)?: try c.encode(m, forKey: .sameAs)
            case nil: break
            }
        case let .press(pid, windowId, key, role, label, taskId):
            try c.encode("press", forKey: .kind); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
            try c.encode(key, forKey: .key); try c.encode(role, forKey: .role); try c.encode(label, forKey: .label)
            try c.encodeIfPresent(taskId, forKey: .taskId)
        case let .watchInput(pids):
            try c.encode("watchInput", forKey: .kind); try c.encode(pids, forKey: .pids)
        case let .watchWindows(windows):
            try c.encode("watchWindows", forKey: .kind); try c.encode(windows, forKey: .windows)
        case let .watchPresses(windows):
            try c.encode("watchPresses", forKey: .kind); try c.encode(windows, forKey: .windows)
        case let .raise(pid, windowId, taskId):
            try c.encode("raise", forKey: .kind); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
            try c.encodeIfPresent(taskId, forKey: .taskId)
        case let .calendarFind(calendar, title, start, end):
            try c.encode("calendarFind", forKey: .kind)
            try c.encode(calendar, forKey: .calendar); try c.encode(title, forKey: .title); try c.encode(start, forKey: .start); try c.encode(end, forKey: .end)
        case let .calendarAdd(calendar, title, start, end, taskId):
            try c.encode("calendarAdd", forKey: .kind)
            try c.encode(calendar, forKey: .calendar); try c.encode(title, forKey: .title); try c.encode(start, forKey: .start); try c.encode(end, forKey: .end)
            try c.encode(taskId, forKey: .taskId)
        case let .calendarGet(id):
            try c.encode("calendarGet", forKey: .kind); try c.encode(id, forKey: .id)
        case let .calendarRemove(id, taskId):
            try c.encode("calendarRemove", forKey: .kind); try c.encode(id, forKey: .id); try c.encode(taskId, forKey: .taskId)
        case let .calendarDispose(calendar, taskId):
            try c.encode("calendarDispose", forKey: .kind); try c.encode(calendar, forKey: .calendar); try c.encode(taskId, forKey: .taskId)
        }
    }
}

/// What a write says about the element it writes (B23, S1 audit #6): record it under the helper's mark, or require it
/// to be the one recorded under that mark.
public enum ElementIdentity: Equatable, Sendable {
    case mark(String)
    case sameAs(String)
}

public struct WatchedWindow: Codable, Equatable, Hashable, Sendable {
    public var pid: Int
    public var windowId: String
    public init(pid: Int, windowId: String) { self.pid = pid; self.windowId = windowId }
}

public struct ReaderCommand: Codable, Equatable, Sendable {
    public static let type = "readerCommand"
    public var id: String
    /// Milliseconds since the epoch after which the reader must not act: the helper has stopped waiting.
    public var expires: Int64
    public var verb: ReaderVerb
    public init(id: String, expires: Int64, verb: ReaderVerb) { self.id = id; self.expires = expires; self.verb = verb }
    enum CodingKeys: String, CodingKey { case id, expires, verb }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); expires = try c.decode(Int64.self, forKey: .expires)
        verb = try c.decode(ReaderVerb.self, forKey: .verb)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(expires, forKey: .expires); try c.encode(verb, forKey: .verb)
    }
}

/// Lets the reader act for one task in one window of one process until `expires`. Mirrors ActGrant in protocol.ts;
/// GrantTable caps it at Grants.maxMs after it arrives.
public struct ActGrant: Codable, Equatable, Sendable {
    public static let type = "actGrant"
    public var taskId: String
    public var pid: Int
    public var windowId: String
    public var at: Int64
    public var expires: Int64
    public init(taskId: String, pid: Int, windowId: String, at: Int64, expires: Int64) {
        self.taskId = taskId; self.pid = pid; self.windowId = windowId; self.at = at; self.expires = expires
    }
    enum CodingKeys: String, CodingKey { case taskId, pid, windowId, at, expires }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId); pid = try c.decode(Int.self, forKey: .pid)
        windowId = try c.decode(String.self, forKey: .windowId)
        at = try c.decode(Int64.self, forKey: .at); expires = try c.decode(Int64.self, forKey: .expires)
        if taskId.isEmpty || windowId.isEmpty { throw ProtocolError("an act grant names a task and a window") }
        // zod's ms is a nonnegative integer; checked first, so the subtraction below cannot overflow.
        guard at >= 0, expires >= 0 else { throw ProtocolError("at and expires are milliseconds since the epoch, never negative") }
        guard expires > at, expires - at <= GrantTable.maxMs else { throw ProtocolError("expires must be after at and at most \(GrantTable.maxMs) ms after it") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
        try c.encode(at, forKey: .at); try c.encode(expires, forKey: .expires)
    }
}

/// Ends a task's act grant. Mirrors ActRevoke in protocol.ts.
public struct ActRevoke: Codable, Equatable, Sendable {
    public static let type = "actRevoke"
    public var taskId: String
    public var at: Int64
    public init(taskId: String, at: Int64) { self.taskId = taskId; self.at = at }
    enum CodingKeys: String, CodingKey { case taskId, at }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId); at = try c.decode(Int64.self, forKey: .at)
        if taskId.isEmpty { throw ProtocolError("an act revoke names a task") }
        guard at >= 0 else { throw ProtocolError("at is milliseconds since the epoch, never negative") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId); try c.encode(at, forKey: .at)
    }
}

/// `notSameElement` (B23): a write's sameAs did not hold. `focusMoved` (B23): focus left a web field the reader had
/// just focused, so it wrote nothing.
public enum VerbOutcome: String, Codable, Sendable { case ok, notAllowed, noWindow, noElement, changed, secure, axError, blocked, notSameElement, focusMoved }

/// Why the calendar adapter refused: no Calendar access (the reader never asks for it), or no local source.
public enum CalendarBlock: String, Codable, Sendable { case tcc, noLocalSource }

/// One event in a calendar the reader created, as the calendar verbs answer it. Checked as protocol.ts
/// checks it: non-empty id and calendar, times ISO 8601 with offset.
public struct CalendarEventRecord: Codable, Equatable, Sendable {
    public var id: String
    public var calendar: String
    public var title: String
    public var start: String
    public var end: String
    public init(id: String, calendar: String, title: String, start: String, end: String) {
        self.id = id; self.calendar = calendar; self.title = title; self.start = start; self.end = end
    }
    enum CodingKeys: String, CodingKey { case id, calendar, title, start, end }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); calendar = try c.decode(String.self, forKey: .calendar)
        title = try c.decode(String.self, forKey: .title); start = try c.decode(String.self, forKey: .start); end = try c.decode(String.self, forKey: .end)
        if id.isEmpty || calendar.isEmpty { throw ProtocolError("an event names its id and calendar") }
        guard CalendarTime.parse(start) != nil, CalendarTime.parse(end) != nil else { throw ProtocolError("start and end are ISO 8601 times with an offset") }
    }
}

/// Lets the reader write to its calendars for one task until `expires`, at most GrantTable.maxMs after it
/// arrives. Mirrors CalendarGrant in protocol.ts: the helper sends it only for a task from an accepted
/// offer, and the task's actRevoke ends it.
public struct CalendarGrant: Codable, Equatable, Sendable {
    public static let type = "calendarGrant"
    public var taskId: String
    public var at: Int64
    public var expires: Int64
    public init(taskId: String, at: Int64, expires: Int64) { self.taskId = taskId; self.at = at; self.expires = expires }
    enum CodingKeys: String, CodingKey { case taskId, at, expires }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId); at = try c.decode(Int64.self, forKey: .at); expires = try c.decode(Int64.self, forKey: .expires)
        if taskId.isEmpty { throw ProtocolError("a calendar grant names a task") }
        guard at >= 0, expires >= 0 else { throw ProtocolError("at and expires are milliseconds since the epoch, never negative") }
        guard expires > at, expires - at <= GrantTable.maxMs else { throw ProtocolError("expires must be after at and at most \(GrantTable.maxMs) ms after it") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId); try c.encode(at, forKey: .at); try c.encode(expires, forKey: .expires)
    }
}

/// ISO 8601 times with an offset, as protocol.ts's z.iso.datetime({ offset: true }) takes them.
public enum CalendarTime {
    public static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }
    /// Local wall-clock time with the offset that applies on that date.
    public static func format(_ d: Date, zone: TimeZone = .current) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = zone
        return f.string(from: d)
    }
}

public struct VerbResult: Codable, Equatable, Sendable {
    public static let type = "verbResult"
    public var id: String
    public var at: Int64
    public var outcome: VerbOutcome
    public var detail: String?
    /// A calendar verb's event: the one found, added or got; nil when there is none.
    public var event: CalendarEventRecord?
    /// With outcome blocked, and only there.
    public var blocked: CalendarBlock?
    public init(id: String, at: Int64, outcome: VerbOutcome, detail: String?, event: CalendarEventRecord? = nil, blocked: CalendarBlock? = nil) {
        self.id = id; self.at = at; self.outcome = outcome; self.detail = detail; self.event = event; self.blocked = blocked
    }
    enum CodingKeys: String, CodingKey { case id, at, outcome, detail, event, blocked }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Int64.self, forKey: .at)
        outcome = try c.decode(VerbOutcome.self, forKey: .outcome); detail = try c.decodeNullable(String.self, forKey: .detail)
        event = try c.decodeOptional(CalendarEventRecord.self, forKey: .event)
        blocked = try c.decodeOptional(CalendarBlock.self, forKey: .blocked)
        if (outcome == .blocked) != (blocked != nil) { throw ProtocolError("blocked comes with outcome blocked, and blocked needs it") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(outcome, forKey: .outcome); try c.encode(detail, forKey: .detail)
        try c.encodeIfPresent(event, forKey: .event); try c.encodeIfPresent(blocked, forKey: .blocked)
    }
}

/// Real input in a watched process. No key codes or characters, only that it happened.
public struct UserInput: Codable, Equatable, Sendable {
    public static let type = "userInput"
    public enum Kind: String, Codable, Sendable { case key, mouse }
    public var at: Int64
    public var pid: Int
    public var kind: Kind
    /// Mouse location in Accessibility coordinates as [x, y]; nil for keys.
    public var point: [Double]?
    public init(at: Int64, pid: Int, kind: Kind, point: [Double]?) { self.at = at; self.pid = pid; self.kind = kind; self.point = point }
    enum CodingKeys: String, CodingKey { case at, pid, kind, point }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); pid = try c.decode(Int.self, forKey: .pid)
        kind = try c.decode(Kind.self, forKey: .kind); point = try c.decodeNullable([Double].self, forKey: .point)
        if let p = point, p.count != 2 { throw ProtocolError("point must hold two numbers") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(pid, forKey: .pid); try c.encode(kind, forKey: .kind); try c.encode(point, forKey: .point)
    }
}

/// B20: the user pressed something in a window under a press watch: the pressable element under the click,
/// its role and label as the element carries them, and when the button went down. `key` is the element's key
/// in the window's latest walk, nil when that walk did not keep it. Mirrors UserPress in protocol.ts.
public struct UserPress: Codable, Equatable, Sendable {
    public static let type = "userPress"
    /// How the press was made: a click, Return or keypad Enter on the window's default button, or Space on the
    /// focused button (B21, KeyPresses). protocol.ts PressVia.
    public enum Via: String, Codable, Sendable { case click, `return`, enter, space }
    public var at: Int64
    public var pid: Int
    public var windowId: String
    public var key: String?
    public var role: String
    public var label: String
    public var via: Via
    public init(at: Int64, pid: Int, windowId: String, key: String?, role: String, label: String, via: Via) {
        self.at = at; self.pid = pid; self.windowId = windowId; self.key = key; self.role = role; self.label = label; self.via = via
    }
    enum CodingKeys: String, CodingKey { case at, pid, windowId, key, role, label, via }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); pid = try c.decode(Int.self, forKey: .pid)
        windowId = try c.decode(String.self, forKey: .windowId); key = try c.decodeNullable(String.self, forKey: .key)
        role = try c.decode(String.self, forKey: .role); label = try c.decode(String.self, forKey: .label)
        via = try c.decode(Via.self, forKey: .via)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
        try c.encode(key, forKey: .key); try c.encode(role, forKey: .role); try c.encode(label, forKey: .label)
        try c.encode(via, forKey: .via)
    }
}

public struct TaskProgress: Codable, Equatable, Sendable {
    public static let type = "taskProgress"
    public enum Phase: String, Codable, Sendable { case started, skipped, acting, verified, paused, handoff, stopped, done, undone }
    /// Why a run stopped, so the host can name it without reading `detail`; protocol.ts StopReason has a line for each.
    public enum StopReason: String, Codable, Sendable {
        case you, changed, sheet, windowGone, ambiguous, readerRestarted, reader, mismatch, unreachable, notConfigured, refused, error
    }
    public var at: Int64
    public var taskId: String
    public var planId: String
    public var phase: Phase
    public var step: Int?
    public var steps: Int
    public var says: String?
    public var detail: String?
    /// On `done` only: the fields the run wrote, each counted once.
    public var written: Int?
    /// On `undone` only: what was restored, what was left as it was, and presses, which no undo reverses.
    public var restored: Int?
    public var notRestored: Int?
    public var notUndoablePresses: Int?
    /// On `stopped`, and only there: why. The activity record of the same stop says "failed".
    public var stopReason: StopReason?
    /// On `handoff` only: the calendar step needs Calendar access or a local account from the user.
    public var blocked: CalendarBlock?
    /// B19: true on every progress of a run a skill started from its trigger without a Tab; nil on every other run.
    public var unprompted: Bool?
    enum CodingKeys: String, CodingKey { case at, taskId, planId, phase, step, steps, says, detail, written, restored, notRestored, notUndoablePresses, stopReason, blocked, unprompted }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); taskId = try c.decode(String.self, forKey: .taskId)
        planId = try c.decode(String.self, forKey: .planId); phase = try c.decode(Phase.self, forKey: .phase)
        step = try c.decodeNullable(Int.self, forKey: .step); steps = try c.decode(Int.self, forKey: .steps)
        says = try c.decodeNullable(String.self, forKey: .says); detail = try c.decodeNullable(String.self, forKey: .detail)
        written = try c.decodeOptional(Int.self, forKey: .written); restored = try c.decodeOptional(Int.self, forKey: .restored)
        notRestored = try c.decodeOptional(Int.self, forKey: .notRestored); notUndoablePresses = try c.decodeOptional(Int.self, forKey: .notUndoablePresses)
        for n in [written, restored, notRestored, notUndoablePresses] where (n ?? 0) < 0 { throw ProtocolError("taskProgress counts are never negative") }
        stopReason = try c.decodeOptional(StopReason.self, forKey: .stopReason)
        if (phase == .stopped) != (stopReason != nil) { throw ProtocolError("stopReason is on stopped progress, and only there") }
        blocked = try c.decodeOptional(CalendarBlock.self, forKey: .blocked)
        if blocked != nil && phase != .handoff { throw ProtocolError("blocked is on a hand-off only") }
        unprompted = try c.decodeOptional(Bool.self, forKey: .unprompted)
        if unprompted == false { throw ProtocolError("unprompted is true or absent") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(taskId, forKey: .taskId); try c.encode(planId, forKey: .planId)
        try c.encode(phase, forKey: .phase); try c.encode(step, forKey: .step); try c.encode(steps, forKey: .steps)
        try c.encode(says, forKey: .says); try c.encode(detail, forKey: .detail)
        try c.encodeIfPresent(written, forKey: .written); try c.encodeIfPresent(restored, forKey: .restored)
        try c.encodeIfPresent(notRestored, forKey: .notRestored); try c.encodeIfPresent(notUndoablePresses, forKey: .notUndoablePresses)
        try c.encodeIfPresent(stopReason, forKey: .stopReason); try c.encodeIfPresent(blocked, forKey: .blocked)
        try c.encodeIfPresent(unprompted, forKey: .unprompted)
    }
}

/// Any message on the socket, decoded by its `type`.
public enum Message: Codable, Equatable, Sendable {
    case hello(Hello), snapshot(Snapshot), focus(Focus), appSwitch(AppSwitch), windowClosed(WindowClosed)
    case pasteboard(Pasteboard), fillRequest(FillRequest), fillProposal(FillProposal), error(HelperError)
    case readerCommand(ReaderCommand), verbResult(VerbResult), userInput(UserInput), taskProgress(TaskProgress)
    case fillResult(FillResult), taskControl(TaskControl), activityRequest(ActivityRequest), activity(Activity), activityReply(ActivityReply)
    case alternatives(OfferAlternatives), action(OfferAction), popup(OfferPopup), offerAccept(OfferAccept), offerStop(OfferStop)
    case offerWithdrawn(OfferWithdrawn), settings(GateSettings), actGrant(ActGrant), actRevoke(ActRevoke)
    case planRequest(PlanRequest), planProposal(PlanProposal), calendarGrant(CalendarGrant)
    case skillOffer(SkillOffer), skillAnswer(SkillAnswer), memoryReply(MemoryReply), userPress(UserPress)
    case helperAuth(HelperAuth)

    public init(from decoder: Decoder) throws {
        let t = try decoder.container(keyedBy: Envelope.self).decode(String.self, forKey: .type)
        switch t {
        case Hello.type: self = .hello(try Hello(from: decoder))
        case Snapshot.type: self = .snapshot(try Snapshot(from: decoder))
        case Focus.type: self = .focus(try Focus(from: decoder))
        case AppSwitch.type: self = .appSwitch(try AppSwitch(from: decoder))
        case WindowClosed.type: self = .windowClosed(try WindowClosed(from: decoder))
        case Pasteboard.type: self = .pasteboard(try Pasteboard(from: decoder))
        case FillRequest.type: self = .fillRequest(try FillRequest(from: decoder))
        case FillProposal.type: self = .fillProposal(try FillProposal(from: decoder))
        case HelperError.type: self = .error(try HelperError(from: decoder))
        case ReaderCommand.type: self = .readerCommand(try ReaderCommand(from: decoder))
        case VerbResult.type: self = .verbResult(try VerbResult(from: decoder))
        case UserInput.type: self = .userInput(try UserInput(from: decoder))
        case TaskProgress.type: self = .taskProgress(try TaskProgress(from: decoder))
        case FillResult.type: self = .fillResult(try FillResult(from: decoder))
        case TaskControl.type: self = .taskControl(try TaskControl(from: decoder))
        case ActivityRequest.type: self = .activityRequest(try ActivityRequest(from: decoder))
        case Activity.type: self = .activity(try Activity(from: decoder))
        case ActivityReply.type: self = .activityReply(try ActivityReply(from: decoder))
        case OfferAlternatives.type: self = .alternatives(try OfferAlternatives(from: decoder))
        case OfferAction.type: self = .action(try OfferAction(from: decoder))
        case OfferPopup.type: self = .popup(try OfferPopup(from: decoder))
        case OfferAccept.type: self = .offerAccept(try OfferAccept(from: decoder))
        case OfferStop.type: self = .offerStop(try OfferStop(from: decoder))
        case OfferWithdrawn.type: self = .offerWithdrawn(try OfferWithdrawn(from: decoder))
        case GateSettings.type: self = .settings(try GateSettings(from: decoder))
        case ActGrant.type: self = .actGrant(try ActGrant(from: decoder))
        case ActRevoke.type: self = .actRevoke(try ActRevoke(from: decoder))
        case PlanRequest.type: self = .planRequest(try PlanRequest(from: decoder))
        case PlanProposal.type: self = .planProposal(try PlanProposal(from: decoder))
        case CalendarGrant.type: self = .calendarGrant(try CalendarGrant(from: decoder))
        case SkillOffer.type: self = .skillOffer(try SkillOffer(from: decoder))
        case SkillAnswer.type: self = .skillAnswer(try SkillAnswer(from: decoder))
        case MemoryReply.type: self = .memoryReply(try MemoryReply(from: decoder))
        case UserPress.type: self = .userPress(try UserPress(from: decoder))
        case HelperAuth.type: self = .helperAuth(try HelperAuth(from: decoder))
        default: throw ProtocolError("unknown message type \(t)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .hello(let m): try m.encode(to: encoder)
        case .snapshot(let m): try m.encode(to: encoder)
        case .focus(let m): try m.encode(to: encoder)
        case .appSwitch(let m): try m.encode(to: encoder)
        case .windowClosed(let m): try m.encode(to: encoder)
        case .pasteboard(let m): try m.encode(to: encoder)
        case .fillRequest(let m): try m.encode(to: encoder)
        case .fillProposal(let m): try m.encode(to: encoder)
        case .error(let m): try m.encode(to: encoder)
        case .readerCommand(let m): try m.encode(to: encoder)
        case .verbResult(let m): try m.encode(to: encoder)
        case .userInput(let m): try m.encode(to: encoder)
        case .taskProgress(let m): try m.encode(to: encoder)
        case .fillResult(let m): try m.encode(to: encoder)
        case .taskControl(let m): try m.encode(to: encoder)
        case .activityRequest(let m): try m.encode(to: encoder)
        case .activity(let m): try m.encode(to: encoder)
        case .activityReply(let m): try m.encode(to: encoder)
        case .alternatives(let m): try m.encode(to: encoder)
        case .action(let m): try m.encode(to: encoder)
        case .popup(let m): try m.encode(to: encoder)
        case .offerAccept(let m): try m.encode(to: encoder)
        case .offerStop(let m): try m.encode(to: encoder)
        case .offerWithdrawn(let m): try m.encode(to: encoder)
        case .settings(let m): try m.encode(to: encoder)
        case .actGrant(let m): try m.encode(to: encoder)
        case .actRevoke(let m): try m.encode(to: encoder)
        case .planRequest(let m): try m.encode(to: encoder)
        case .planProposal(let m): try m.encode(to: encoder)
        case .calendarGrant(let m): try m.encode(to: encoder)
        case .skillOffer(let m): try m.encode(to: encoder)
        case .skillAnswer(let m): try m.encode(to: encoder)
        case .memoryReply(let m): try m.encode(to: encoder)
        case .userPress(let m): try m.encode(to: encoder)
        case .helperAuth(let m): try m.encode(to: encoder)
        }
    }
}

public enum NDJSON {
    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }

    public static func line<T: Encodable>(_ value: T, encoder: JSONEncoder = encoder()) throws -> Data {
        var d = try encoder.encode(value)
        d.append(0x0A)
        return d
    }
}
