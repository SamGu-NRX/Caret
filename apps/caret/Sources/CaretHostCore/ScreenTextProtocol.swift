import Foundation

public struct ScreenTextRequest: Codable, Equatable, Sendable {
    public let type: String
    public let v: Int
    public let id: String
    public let revision: UInt64
    public let pid: Int32
    public let windowNumber: UInt32
    public let maxCharacters: Int
    public let appsOff: [String]
    public let sitesOff: [String]
    public let site: String?

    private enum CodingKeys: String, CodingKey { case type, v, id, revision, pid, windowNumber, maxCharacters, appsOff, sitesOff, site }
    public init(id: String, revision: UInt64, pid: Int32, windowNumber: UInt32, maxCharacters: Int = 2048, appsOff: [String] = [], sitesOff: [String] = [], site: String? = nil) {
        self.type = "screenTextRequest"; self.v = 1; self.id = id; self.revision = revision; self.pid = pid; self.windowNumber = windowNumber; self.maxCharacters = maxCharacters; self.appsOff = appsOff; self.sitesOff = sitesOff; self.site = site
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        guard type == "screenTextRequest" else { throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "expected screenTextRequest") }
        v = try c.decode(Int.self, forKey: .v)
        guard v == 1 else { throw DecodingError.dataCorruptedError(forKey: .v, in: c, debugDescription: "unsupported screen text protocol version") }
        id = try c.decode(String.self, forKey: .id); revision = try c.decode(UInt64.self, forKey: .revision); pid = try c.decode(Int32.self, forKey: .pid); maxCharacters = try c.decode(Int.self, forKey: .maxCharacters)
        windowNumber = try c.decode(UInt32.self, forKey: .windowNumber)
        guard windowNumber > 0 else { throw DecodingError.dataCorruptedError(forKey: .windowNumber, in: c, debugDescription: "expected a positive AX window number") }
        guard pid > 0 else { throw DecodingError.dataCorruptedError(forKey: .pid, in: c, debugDescription: "expected a positive app pid") }
        appsOff = try c.decodeIfPresent([String].self, forKey: .appsOff) ?? []; sitesOff = try c.decodeIfPresent([String].self, forKey: .sitesOff) ?? []; site = try c.decodeIfPresent(String.self, forKey: .site)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type); try c.encode(v, forKey: .v); try c.encode(id, forKey: .id); try c.encode(revision, forKey: .revision); try c.encode(pid, forKey: .pid); try c.encode(windowNumber, forKey: .windowNumber); try c.encode(maxCharacters, forKey: .maxCharacters); try c.encode(appsOff, forKey: .appsOff); try c.encode(sitesOff, forKey: .sitesOff); try c.encodeIfPresent(site, forKey: .site)
    }
}

public struct ScreenTextReply: Codable, Equatable, Sendable {
    public let type: String
    public let v: Int
    public let id: String
    public let revision: UInt64
    public let text: String?

    private enum CodingKeys: String, CodingKey { case type, v, id, revision, text }
    public init(id: String, revision: UInt64, text: String?) { self.type = "screenTextReply"; self.v = 1; self.id = id; self.revision = revision; self.text = text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        guard type == "screenTextReply" else { throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "expected screenTextReply") }
        v = try c.decode(Int.self, forKey: .v)
        guard v == 1 else { throw DecodingError.dataCorruptedError(forKey: .v, in: c, debugDescription: "unsupported screen text protocol version") }
        id = try c.decode(String.self, forKey: .id); revision = try c.decode(UInt64.self, forKey: .revision); text = try c.decodeIfPresent(String.self, forKey: .text)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type); try c.encode(v, forKey: .v); try c.encode(id, forKey: .id); try c.encode(revision, forKey: .revision); try c.encode(text, forKey: .text)
    }
}

/// A helper-issued revision, not the host's generation serial. Sent only to authenticated screenText hosts.
public struct ScreenTextRevision: Codable, Equatable, Sendable {
    public static let capability = "screenText"
    public let type: String
    public let v: Int
    public let revision: UInt64

    public init(revision: UInt64) { type = "screenTextRevision"; v = 1; self.revision = revision }
    private enum CodingKeys: String, CodingKey { case type, v, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        v = try c.decode(Int.self, forKey: .v)
        guard type == "screenTextRevision", v == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "expected screenTextRevision v1")
        }
        revision = try c.decode(UInt64.self, forKey: .revision)
    }
}
