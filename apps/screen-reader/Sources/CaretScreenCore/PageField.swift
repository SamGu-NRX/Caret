import Foundation

/// H10: the field the user is in on a page, as the helper's page engine read it (protocol.ts `PageField`). The host
/// cannot read it itself: Chrome shows Accessibility no web content and no focused element while a page field has
/// focus (evidence/host/h10/probe). `key` is the field's node key in the page window, the key fill proposals name; nil
/// when no control of that tab has focus. `frame` is in screen points, nil when the walk did not say where the
/// viewport is. `app` is the browser the bridge was launched by.
public struct PageField: Codable, Equatable, Sendable {
    public static let type = "pageField"
    public var at: Int64
    public var app: AppRef
    public var windowId: String
    public var title: String
    public var key: String?
    public var role: String
    public var editable: Bool
    public var empty: Bool
    public var frame: Frame?

    public init(at: Int64, app: AppRef, windowId: String, title: String, key: String?, role: String, editable: Bool, empty: Bool, frame: Frame?) {
        self.at = at; self.app = app; self.windowId = windowId; self.title = title; self.key = key
        self.role = role; self.editable = editable; self.empty = empty; self.frame = frame
    }

    enum CodingKeys: String, CodingKey { case at, app, windowId, title, key, role, editable, empty, frame }

    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); app = try c.decode(AppRef.self, forKey: .app)
        windowId = try c.decode(String.self, forKey: .windowId); title = try c.decode(String.self, forKey: .title)
        key = try c.decodeNullable(String.self, forKey: .key)
        role = try c.decode(String.self, forKey: .role); editable = try c.decode(Bool.self, forKey: .editable)
        empty = try c.decode(Bool.self, forKey: .empty); frame = try c.decodeNullable(Frame.self, forKey: .frame)
        guard at >= 0 else { throw ProtocolError("at is milliseconds since the epoch, never negative") }
        guard !windowId.isEmpty else { throw ProtocolError("pageField names its window") }
        if key?.isEmpty == true { throw ProtocolError("pageField's key is null or at least 1 character") }
    }

    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(app, forKey: .app); try c.encode(windowId, forKey: .windowId)
        try c.encode(title, forKey: .title); try c.encode(key, forKey: .key); try c.encode(role, forKey: .role)
        try c.encode(editable, forKey: .editable); try c.encode(empty, forKey: .empty); try c.encode(frame, forKey: .frame)
    }
}
