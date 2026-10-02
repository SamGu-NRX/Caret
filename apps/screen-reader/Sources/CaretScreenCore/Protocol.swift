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
    public init(windowId: String, kind: String, title: String, frame: Frame?) {
        self.windowId = windowId; self.kind = kind; self.title = title; self.frame = frame
    }
    enum CodingKeys: String, CodingKey { case windowId, kind, title, frame }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowId = try c.decode(String.self, forKey: .windowId)
        kind = try c.decode(String.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        frame = try c.decodeNullable(Frame.self, forKey: .frame)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(frame, forKey: .frame)
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
    case initial, focus, event, leave, background, request
}

public enum ClientRole: String, Codable, Sendable { case reader, consumer }
public enum ReaderMode: String, Codable, Sendable { case live, shadow }

/// Every message carries `type` and `v`; this checks both on decode and writes both on encode.
private enum Envelope: String, CodingKey { case type, v }

private func checkEnvelope(_ decoder: Decoder, _ type: String) throws {
    let c = try decoder.container(keyedBy: Envelope.self)
    let t = try c.decode(String.self, forKey: .type)
    let v = try c.decode(Int.self, forKey: .v)
    guard t == type else { throw ProtocolError("expected type \(type), got \(t)") }
    guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v)") }
}

private func writeEnvelope(_ encoder: Encoder, _ type: String) throws {
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
    public init(role: ClientRole, mode: ReaderMode, pid: Int, version: String) {
        self.role = role; self.mode = mode; self.pid = pid; self.version = version
    }
    enum CodingKeys: String, CodingKey { case role, mode, pid, version }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(ClientRole.self, forKey: .role)
        mode = try c.decode(ReaderMode.self, forKey: .mode)
        pid = try c.decode(Int.self, forKey: .pid)
        version = try c.decode(String.self, forKey: .version)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role); try c.encode(mode, forKey: .mode)
        try c.encode(pid, forKey: .pid); try c.encode(version, forKey: .version)
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
    public var windowId: String
    public var bundleId: String
    public var appName: String
    public var windowTitle: String
    public var nodeKey: String
    public var kind: ValueKind?
    enum CodingKeys: String, CodingKey { case windowId, bundleId, appName, windowTitle, nodeKey, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windowId = try c.decode(String.self, forKey: .windowId); bundleId = try c.decode(String.self, forKey: .bundleId)
        appName = try c.decode(String.self, forKey: .appName); windowTitle = try c.decode(String.self, forKey: .windowTitle)
        nodeKey = try c.decode(String.self, forKey: .nodeKey); kind = try c.decodeNullable(ValueKind.self, forKey: .kind)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId); try c.encode(bundleId, forKey: .bundleId)
        try c.encode(appName, forKey: .appName); try c.encode(windowTitle, forKey: .windowTitle)
        try c.encode(nodeKey, forKey: .nodeKey); try c.encode(kind, forKey: .kind)
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
    enum CodingKeys: String, CodingKey { case key, frame, descriptor, choice, confidence, value, source }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key); frame = try c.decodeNullable(Frame.self, forKey: .frame)
        descriptor = try c.decode(String.self, forKey: .descriptor); choice = try c.decode(String.self, forKey: .choice)
        confidence = try c.decode(Double.self, forKey: .confidence)
        value = try c.decodeNullable(String.self, forKey: .value); source = try c.decodeNullable(FillSource.self, forKey: .source)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key); try c.encode(frame, forKey: .frame); try c.encode(descriptor, forKey: .descriptor)
        try c.encode(choice, forKey: .choice); try c.encode(confidence, forKey: .confidence)
        try c.encode(value, forKey: .value); try c.encode(source, forKey: .source)
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
    public var windowId: String
    public var bundleId: String
    public var triggerKey: String
    public var fields: [FillField]
    public var candidates: Int
    public var jev: JevUsage
    enum CodingKeys: String, CodingKey { case id, at, windowId, bundleId, triggerKey, fields, candidates, jev }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Int64.self, forKey: .at)
        windowId = try c.decode(String.self, forKey: .windowId); bundleId = try c.decode(String.self, forKey: .bundleId)
        triggerKey = try c.decode(String.self, forKey: .triggerKey); fields = try c.decode([FillField].self, forKey: .fields)
        candidates = try c.decode(Int.self, forKey: .candidates); jev = try c.decode(JevUsage.self, forKey: .jev)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(windowId, forKey: .windowId)
        try c.encode(bundleId, forKey: .bundleId); try c.encode(triggerKey, forKey: .triggerKey)
        try c.encode(fields, forKey: .fields); try c.encode(candidates, forKey: .candidates); try c.encode(jev, forKey: .jev)
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

/// Any message on the socket, decoded by its `type`.
public enum Message: Codable, Equatable, Sendable {
    case hello(Hello), snapshot(Snapshot), focus(Focus), appSwitch(AppSwitch), windowClosed(WindowClosed)
    case pasteboard(Pasteboard), fillRequest(FillRequest), fillProposal(FillProposal), error(HelperError)

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
