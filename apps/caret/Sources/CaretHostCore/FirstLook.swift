import CaretScreenCore
import Foundation

// The first look: at the end of onboarding the host asks the helper to run every enabled generator
// once over the windows already open and answer with its best real offer, or with nothing (Fable
// plan, section 1). The helper does not speak this yet; these types are the contract it will
// implement, and `Tests/CaretHostCoreTests/Fixtures/first-look.ndjson` holds one line of each
// shape. Same envelope as the rest of the protocol (`type`, `v`); nullable fields are always
// present and may be null.

/// Host to helper, on the consumer connection. The reply comes back to this connection only.
public struct FirstLookRequest: Codable, Equatable, Sendable {
    public static let type = "firstLook"
    /// The host gives up this long after asking (`FirstLookRequest.deadlineMs` plus a second of
    /// grace). Assumed, not measured: one walk of every open window plus two Jev asks per
    /// candidate.
    public static let defaultDeadlineMs = 8000

    public var requestId: String
    /// Milliseconds since the epoch.
    public var at: Int64
    /// The generator families to run (`fill`, `pending`, `loop`, `routine`), from the roles chosen
    /// in onboarding. Ghost text is the host's and never part of a first look.
    public var families: [String]
    /// `quiet`, `balanced` or `eager`, for the helper's gate.
    public var level: CaretLevel
    /// Answer within this many milliseconds; anything later is ignored.
    public var deadlineMs: Int

    public init(requestId: String, at: Int64, families: [String], level: CaretLevel, deadlineMs: Int = FirstLookRequest.defaultDeadlineMs) {
        self.requestId = requestId
        self.at = at
        self.families = families
        self.level = level
        self.deadlineMs = deadlineMs
    }

    /// The families the settings enable, in the helper's order.
    public static func families(for settings: CaretSettings) -> [String] {
        ["fill", "pending", "loop", "routine"].filter { settings.gate.allows(family: $0) }
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, families, level, deadlineMs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try FirstLookWire.checkEnvelope(c, Self.type)
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        families = try c.decode([String].self, forKey: .families)
        level = try c.decode(CaretLevel.self, forKey: .level)
        deadlineMs = try c.decode(Int.self, forKey: .deadlineMs)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(at, forKey: .at)
        try c.encode(families, forKey: .families)
        try c.encode(level, forKey: .level)
        try c.encode(deadlineMs, forKey: .deadlineMs)
    }

    /// One NDJSON line.
    public func line() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self) + Data("\n".utf8)
    }
}

/// Helper to host: the best offer found, nothing, or why the look failed.
public struct FirstLookReply: Codable, Equatable, Sendable {
    public static let type = "firstLookReply"

    public enum Outcome: String, Codable, Sendable {
        /// `found` holds the best offer.
        case found
        /// Every generator ran and none had an offer worth showing.
        case nothing
        /// The look could not run; `error` says why, with window ids and reasons, never screen text.
        case error
    }

    /// The best offer. Its content is a pop-up spec, so every value on it points back to the
    /// screen (`PopupSpec.Ref`) and nothing shown can be invented.
    public struct Found: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            /// Something Caret can do: an event from a draft, a reminder.
            case action
            /// Values to copy from one window into a form.
            case fill
            /// Something that finished or needs you in a background window.
            case report
        }

        public var kind: Kind
        /// Which family produced it; one of the request's `families`.
        public var family: String
        /// The helper's key, so a later batch can take it with `offerAccept`.
        public var offerKey: String
        /// Where it was found: the window, as the reader names it, and its app and title.
        public var window: WindowRef
        public var spec: PopupSpec

        public struct WindowRef: Codable, Equatable, Sendable {
            public var pid: Int
            public var windowId: String
            public var appName: String
            public var title: String

            public init(pid: Int, windowId: String, appName: String, title: String) {
                self.pid = pid
                self.windowId = windowId
                self.appName = appName
                self.title = title
            }
        }

        public init(kind: Kind, family: String, offerKey: String, window: WindowRef, spec: PopupSpec) {
            self.kind = kind
            self.family = family
            self.offerKey = offerKey
            self.window = window
            self.spec = spec
        }

        /// The title the first look shows: the spec's header, which a found offer must have.
        public var title: String { spec.header?.title.text ?? "" }
    }

    /// What the look covered, for the debug state and the report.
    public struct Scanned: Codable, Equatable, Sendable {
        public var windows: Int
        public var apps: Int
        public var ms: Int

        public init(windows: Int, apps: Int, ms: Int) {
            self.windows = windows
            self.apps = apps
            self.ms = ms
        }
    }

    public var requestId: String
    public var at: Int64
    public var outcome: Outcome
    public var found: Found?
    public var scanned: Scanned?
    public var error: String?

    public init(requestId: String, at: Int64, outcome: Outcome, found: Found? = nil, scanned: Scanned? = nil, error: String? = nil) {
        self.requestId = requestId
        self.at = at
        self.outcome = outcome
        self.found = found
        self.scanned = scanned
        self.error = error
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, outcome, found, scanned, error }

    /// Strict: `found` is set exactly when the outcome is `found`, `error` exactly when it is
    /// `error`, and a found offer's spec has a header to title it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try FirstLookWire.checkEnvelope(c, Self.type)
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        found = try FirstLookWire.nullable(c, Found.self, .found)
        scanned = try FirstLookWire.nullable(c, Scanned.self, .scanned)
        error = try FirstLookWire.nullable(c, String.self, .error)
        if let problem = Self.problem(outcome: outcome, found: found, error: error) { throw ProtocolError("firstLookReply: \(problem)") }
    }

    static func problem(outcome: Outcome, found: Found?, error: String?) -> String? {
        switch outcome {
        case .found:
            guard let found else { return "outcome found needs found" }
            if error != nil { return "outcome found carries no error" }
            if found.spec.header == nil { return "a found offer's spec needs a header" }
            if found.family.isEmpty || found.offerKey.isEmpty { return "a found offer needs a family and an offerKey" }
        case .nothing:
            if found != nil || error != nil { return "outcome nothing carries neither found nor error" }
        case .error:
            if found != nil { return "outcome error carries no found" }
            if (error ?? "").isEmpty { return "outcome error needs error" }
        }
        return nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(at, forKey: .at)
        try c.encode(outcome, forKey: .outcome)
        try c.encode(found, forKey: .found)
        try c.encode(scanned, forKey: .scanned)
        try c.encode(error, forKey: .error)
    }

    public static func decode(_ line: Data) throws -> FirstLookReply {
        try JSONDecoder().decode(FirstLookReply.self, from: line)
    }
}

enum FirstLookWire {
    static func checkEnvelope<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ type: String) throws {
        guard let typeKey = K(stringValue: "type"), let vKey = K(stringValue: "v") else { throw ProtocolError("no envelope keys") }
        let t = try c.decode(String.self, forKey: typeKey)
        let v = try c.decode(Int.self, forKey: vKey)
        guard t == type else { throw ProtocolError("expected type \(type), got \(t)") }
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v)") }
    }

    /// Present, and possibly null; a missing key is an error, as in the rest of the protocol.
    static func nullable<K: CodingKey, T: Decodable>(_ c: KeyedDecodingContainer<K>, _ t: T.Type, _ key: K) throws -> T? {
        guard c.contains(key) else { throw ProtocolError("missing \(key.stringValue); send null instead") }
        return try c.decodeIfPresent(t, forKey: key)
    }
}
