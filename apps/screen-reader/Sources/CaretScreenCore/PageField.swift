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
    /// How the field draws its text, in screen points (protocol.ts FieldLook); nil when the page did not say.
    public var look: Look?
    /// H13 (protocol.ts PageFieldText): the text around the caret, for inline text. Sent only to a host that declared
    /// pageText; never logged, stored or shown on the debug socket (`description` leaves it out).
    public var text: Text?
    /// H13: the page offers its own inline suggestions in this field, which take Tab (P4 item 9).
    public var ownSuggestions: OwnSuggestions?
    /// H13: in a Google Docs or Sheets editor, whether its text for assistive technology is there.
    public var docsText: DocsText?
    /// H13: the caret in screen points, for a field of the page's top frame; nil when the page could not place it.
    public var caret: Frame?
    /// H13 review: the walked element itself (frame, document, registry id), opaque. The key is a label and an ordinal,
    /// which a replacement field of the same label keeps; an insert names this token and the page refuses any other.
    public var token: String?
    /// H13 review: false when the field's document lost focus (the browser's address bar); nil when not said.
    public var pageFocused: Bool?
    /// H13: what kind of field `text` is from, which decides where inline text may show; nil when the page did not say.
    public var fieldKind: FieldKind?

    /// The text before the caret (at most 2,000 characters), after it (500) and selected.
    public struct Text: Codable, Equatable, Sendable {
        public var before: String
        public var after: String
        public var selection: String
        public init(before: String, after: String, selection: String) {
            self.before = before; self.after = after; self.selection = selection
        }
    }

    public enum OwnSuggestions: String, Codable, Equatable, Sendable, CaseIterable {
        case gmail
        case googleDocs = "google-docs"
    }

    public enum DocsText: String, Codable, Equatable, Sendable { case on, off }

    /// protocol.ts PageFieldKind: a text input, a textarea, a contenteditable editor.
    public enum FieldKind: String, Codable, Equatable, Sendable, CaseIterable {
        case input, textarea, contenteditable
    }

    /// The text's inset from the field's left edge, its font size, whether a placeholder shows, and light text.
    public struct Look: Codable, Equatable, Sendable {
        public var inset: Double
        public var fontSize: Double
        public var placeholder: Bool
        public var dark: Bool
        public init(inset: Double, fontSize: Double, placeholder: Bool, dark: Bool) {
            self.inset = inset; self.fontSize = fontSize; self.placeholder = placeholder; self.dark = dark
        }
    }

    public init(at: Int64, app: AppRef, windowId: String, title: String, key: String?, role: String, editable: Bool, empty: Bool, frame: Frame?, look: Look? = nil,
                text: Text? = nil, ownSuggestions: OwnSuggestions? = nil, docsText: DocsText? = nil, caret: Frame? = nil, token: String? = nil, fieldKind: FieldKind? = nil) {
        self.at = at; self.app = app; self.windowId = windowId; self.title = title; self.key = key
        self.role = role; self.editable = editable; self.empty = empty; self.frame = frame; self.look = look
        self.text = text; self.ownSuggestions = ownSuggestions; self.docsText = docsText; self.caret = caret; self.token = token; self.fieldKind = fieldKind
    }

    enum CodingKeys: String, CodingKey { case at, app, windowId, title, key, role, editable, empty, frame, look, text, ownSuggestions, docsText, caret, token, pageFocused, fieldKind }

    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); app = try c.decode(AppRef.self, forKey: .app)
        windowId = try c.decode(String.self, forKey: .windowId); title = try c.decode(String.self, forKey: .title)
        key = try c.decodeNullable(String.self, forKey: .key)
        role = try c.decode(String.self, forKey: .role); editable = try c.decode(Bool.self, forKey: .editable)
        empty = try c.decode(Bool.self, forKey: .empty); frame = try c.decodeNullable(Frame.self, forKey: .frame)
        look = try c.decodeIfPresent(Look.self, forKey: .look)
        // Null and absent read the same: a helper before H13, a consumer without pageText, a page that said nothing.
        text = try c.decodeIfPresent(Text.self, forKey: .text)
        ownSuggestions = try c.decodeIfPresent(OwnSuggestions.self, forKey: .ownSuggestions)
        docsText = try c.decodeIfPresent(DocsText.self, forKey: .docsText)
        caret = try c.decodeIfPresent(Frame.self, forKey: .caret)
        token = try c.decodeIfPresent(String.self, forKey: .token)
        pageFocused = try c.decodeIfPresent(Bool.self, forKey: .pageFocused)
        fieldKind = try c.decodeIfPresent(FieldKind.self, forKey: .fieldKind)
        if let text, text.before.count > 2000 || text.after.count > 500 || text.selection.count > 2000 {
            throw ProtocolError("pageField's text is longer than a walk reports")
        }
        if let look, look.inset < 0 || look.fontSize < 0 { throw ProtocolError("pageField's look has no negative sizes") }
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
        try c.encodeIfPresent(look, forKey: .look)
        try c.encodeIfPresent(text, forKey: .text); try c.encodeIfPresent(ownSuggestions, forKey: .ownSuggestions)
        try c.encodeIfPresent(docsText, forKey: .docsText); try c.encodeIfPresent(caret, forKey: .caret); try c.encodeIfPresent(token, forKey: .token); try c.encodeIfPresent(pageFocused, forKey: .pageFocused)
        try c.encodeIfPresent(fieldKind, forKey: .fieldKind)
    }
}

extension PageField: CustomStringConvertible, CustomDebugStringConvertible {
    /// H13: a page field as a log line or a debugger shows it, with the length of its text and never the text itself.
    public var description: String {
        "pageField(\(windowId) \(key ?? "none") \(role) text \(text.map { "\($0.before.count)+\($0.after.count)" } ?? "none") own \(ownSuggestions?.rawValue ?? "none"))"
    }
    public var debugDescription: String { description }
}
