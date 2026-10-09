import CaretScreenCore
import Foundation

/// H8 decision 4: what the helper process has spent on models since it started (helper/src/spend.ts,
/// protocol.ts `Spend`; golden lines helper/fixtures/golden/spend.ndjson, copied into the host's test
/// fixtures byte for byte). The host asks for it in its hello and shows the last one on the debug
/// socket's `state`, so a run reads its real spend there.
public struct HelperSpend: Codable, Equatable, Sendable {
    public static let type = "spend"
    public static let capability = "spend"

    /// Calls to one kind of model and what their providers reported; a failed call reported no usage.
    public struct Bucket: Codable, Equatable, Sendable {
        public var calls: Int
        public var failed: Int
        public var inputTokens: Int
        public var outputTokens: Int
        public var costUsd: Double

        public init(calls: Int, failed: Int, inputTokens: Int, outputTokens: Int, costUsd: Double) {
            self.calls = calls; self.failed = failed; self.inputTokens = inputTokens; self.outputTokens = outputTokens; self.costUsd = costUsd
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            calls = try c.decode(Int.self, forKey: .calls)
            failed = try c.decode(Int.self, forKey: .failed)
            inputTokens = try c.decode(Int.self, forKey: .inputTokens)
            outputTokens = try c.decode(Int.self, forKey: .outputTokens)
            costUsd = try c.decode(Double.self, forKey: .costUsd)
            guard calls >= 0, failed >= 0, inputTokens >= 0, outputTokens >= 0, costUsd >= 0, costUsd.isFinite else {
                throw ProtocolError("spend counts and costs are never negative")
            }
        }
    }

    public var at: Int64
    /// When the helper started counting: its start.
    public var since: Int64
    /// TypeSafe's Jev: input tokens only, its output is free.
    public var jev: Bucket
    /// Every writer route (plan, goal, intent).
    public var writer: Bucket

    public var totalUsd: Double { jev.costUsd + writer.costUsd }

    enum CodingKeys: String, CodingKey { case type, v, at, since, jev, writer }

    public init(at: Int64, since: Int64, jev: Bucket, writer: Bucket) {
        self.at = at; self.since = since; self.jev = jev; self.writer = writer
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let t = try c.decode(String.self, forKey: .type)
        guard t == Self.type else { throw ProtocolError("expected spend, got \(t)") }
        guard try c.decode(Int.self, forKey: .v) == Proto.version else { throw ProtocolError("unsupported protocol version for spend") }
        at = try c.decode(Int64.self, forKey: .at)
        since = try c.decode(Int64.self, forKey: .since)
        jev = try c.decode(Bucket.self, forKey: .jev)
        writer = try c.decode(Bucket.self, forKey: .writer)
    }

    /// The debug state's form: the wire fields without the envelope, plus the total.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DebugKeys.self)
        try c.encode(at, forKey: .at); try c.encode(since, forKey: .since)
        try c.encode(jev, forKey: .jev); try c.encode(writer, forKey: .writer); try c.encode(totalUsd, forKey: .totalUsd)
    }

    enum DebugKeys: String, CodingKey { case at, since, jev, writer, totalUsd }
}
