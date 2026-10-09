import CaretScreenCore
import Foundation

/// Host to helper. Builds an allow-list from the current screen without calling a provider.
public struct FirstLookPreviewRequest: Codable, Equatable, Sendable {
    public static let type = "firstLookPreviewRequest"
    public var requestId: String
    public var at: Int64
    public var families: [String]
    public var level: CaretLevel

    public init(requestId: String, at: Int64, families: [String], level: CaretLevel) {
        self.requestId = requestId
        self.at = at
        self.families = families
        self.level = level
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, families, level }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try FirstLookWire.checkEnvelope(c, Self.type)
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        families = try c.decode([String].self, forKey: .families)
        level = try c.decode(CaretLevel.self, forKey: .level)
        guard !requestId.isEmpty, at >= 0 else { throw ProtocolError("invalid first-look preview request") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(at, forKey: .at)
        try c.encode(families, forKey: .families)
        try c.encode(level, forKey: .level)
    }

    public func line() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self) + Data("\n".utf8)
    }
}

/// Helper to host. Allowed window characters, not a prediction of the requests the generators will build.
public struct FirstLookPreview: Codable, Equatable, Sendable {
    public static let type = "firstLookPreview"

    public struct Line: Codable, Equatable, Sendable {
        /// Empty for a placeholder. A placeholder must never carry withheld text.
        public var text: String
        public var sent: Bool

        public init(text: String, sent: Bool) {
            self.text = text
            self.sent = sent
        }
    }

    public struct Window: Codable, Equatable, Sendable {
        public var bundleId: String
        public var appName: String
        public var title: String
        public var lines: [Line]
        /// Upper bound on distinct allowed characters, in UTF-16 units to match the helper's string lengths.
        public var charsSent: Int

        public init(bundleId: String, appName: String, title: String, lines: [Line], charsSent: Int) {
            self.bundleId = bundleId
            self.appName = appName
            self.title = title
            self.lines = lines
            self.charsSent = charsSent
        }
    }

    public var requestId: String
    public var at: Int64
    public var previewId: String
    /// Windows with no allowed text are omitted. Empty means nothing to send.
    public var windows: [Window]
    /// Sum of the window upper bounds. Repeating the same text in multiple requests does not increase this count.
    public var totalChars: Int

    public init(requestId: String, at: Int64, previewId: String, windows: [Window], totalChars: Int) {
        self.requestId = requestId
        self.at = at
        self.previewId = previewId
        self.windows = windows
        self.totalChars = totalChars
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, previewId, windows, totalChars }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try FirstLookWire.checkEnvelope(c, Self.type)
        requestId = try c.decode(String.self, forKey: .requestId)
        at = try c.decode(Int64.self, forKey: .at)
        previewId = try c.decode(String.self, forKey: .previewId)
        windows = try c.decode([Window].self, forKey: .windows)
        totalChars = try c.decode(Int.self, forKey: .totalChars)
        try validate()
    }

    private func validate() throws {
        guard !requestId.isEmpty, !previewId.isEmpty, at >= 0, totalChars >= 0 else {
            throw ProtocolError("invalid first-look preview envelope")
        }
        for window in windows {
            guard window.lines.allSatisfy({ $0.sent ? !$0.text.isEmpty : $0.text.isEmpty }) else {
                throw ProtocolError("placeholder lines carry no text; allowed lines are nonempty")
            }
            guard window.charsSent > 0,
                  window.charsSent == window.lines.reduce(0, { $0 + $1.text.utf16.count }) else {
                throw ProtocolError("charsSent must count allowed characters")
            }
        }
        guard totalChars == windows.reduce(0, { $0 + $1.charsSent }) else {
            throw ProtocolError("totalChars must sum the window upper bounds")
        }
    }

    public func encode(to encoder: Encoder) throws {
        try validate()
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(at, forKey: .at)
        try c.encode(previewId, forKey: .previewId)
        try c.encode(windows, forKey: .windows)
        try c.encode(totalChars, forKey: .totalChars)
    }

    public func line() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self) + Data("\n".utf8)
    }

    public static func decode(_ line: Data) throws -> FirstLookPreview {
        try JSONDecoder().decode(Self.self, from: line)
    }
}
