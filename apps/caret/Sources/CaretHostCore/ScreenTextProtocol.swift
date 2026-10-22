import Foundation

public struct ScreenTextRequest: Codable, Equatable, Sendable {
    public let type = "screenTextRequest"
    public let v = 1
    public let id: String
    public let revision: UInt64
    public let windowID: String
    public let maxCharacters: Int
    public let appsOff: [String]
    public let sitesOff: [String]
    public let site: String?
    public init(id: String, revision: UInt64, windowID: String, maxCharacters: Int = 2048, appsOff: [String] = [], sitesOff: [String] = [], site: String? = nil) { self.id = id; self.revision = revision; self.windowID = windowID; self.maxCharacters = maxCharacters; self.appsOff = appsOff; self.sitesOff = sitesOff; self.site = site }
}

public struct ScreenTextReply: Codable, Equatable, Sendable {
    public let type = "screenTextReply"
    public let v = 1
    public let id: String
    public let revision: UInt64
    public let text: String?
    public init(id: String, revision: UInt64, text: String?) { self.id = id; self.revision = revision; self.text = text }
}

public enum ScreenTextDecision {
    public static func accept(_ reply: ScreenTextReply, requestID: String, revision: UInt64) -> String? {
        guard reply.id == requestID, reply.revision == revision else { return nil }
        return reply.text
    }

    public static func accept(_ reply: ScreenTextReply, requestID: String, revision: UInt64, elapsedNanoseconds: UInt64, deadlineNanoseconds: UInt64 = 40_000_000) -> String? {
        guard elapsedNanoseconds <= deadlineNanoseconds else { return nil }
        return accept(reply, requestID: requestID, revision: revision)
    }
}
