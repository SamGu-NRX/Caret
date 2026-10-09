import CaretScreenCore
import Foundation

/// Host to helper (protocol.ts SessionLocked): the user locked the screen or is signing out. The helper clears the
/// owner verdicts it keeps for the session (fill/owner-cache.ts), which must not outlive either.
public struct SessionLocked: Encodable, Equatable, Sendable {
    public enum Why: String, Encodable, Sendable { case lock, signOut }

    public var at: Int64
    public var why: Why

    public init(at: Int64, why: Why) {
        self.at = at
        self.why = why
    }

    enum CodingKeys: String, CodingKey { case type, v, at, why }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("sessionLocked", forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(at, forKey: .at)
        try c.encode(why, forKey: .why)
    }
}
