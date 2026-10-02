import CaretScreenCore
import Foundation

/// What the host does with one line from the helper's socket.
///
/// The wire types are the screen track's (`CaretScreenCore`, mirroring `helper/src/protocol.ts`).
/// A consumer receives only `fillProposal` and `error`; anything else the helper sends is named
/// and counted rather than treated as a broken connection, so a helper that adds message types
/// does not disconnect an older host.
public enum HelperInbound: Equatable, Sendable {
    case fillProposal(FillProposal)
    case error(HelperError)
    /// A valid protocol message that is not addressed to consumers (reader traffic, or our own
    /// requests echoed back).
    case notForConsumer(type: String)
    /// A `type` this host does not know. Newer helpers may send these.
    case unknown(type: String)

    public static func decode(_ line: Data) throws -> HelperInbound {
        let envelope = try JSONDecoder().decode(EnvelopeProbe.self, from: line)
        guard envelope.v == Proto.version else {
            throw ProtocolError("unsupported protocol version \(envelope.v) for \(envelope.type)")
        }
        switch envelope.type {
        case FillProposal.type, HelperError.type, Hello.type, FillRequest.type,
             "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard":
            switch try JSONDecoder().decode(Message.self, from: line) {
            case .fillProposal(let proposal): return .fillProposal(proposal)
            case .error(let error): return .error(error)
            default: return .notForConsumer(type: envelope.type)
            }
        case FillResult.type:
            return .notForConsumer(type: envelope.type)
        default:
            return .unknown(type: envelope.type)
        }
    }

    private struct EnvelopeProbe: Decodable {
        let type: String
        let v: Int
    }
}

/// Host to helper: what became of one field of a fill proposal after the user pressed Tab (or
/// ⌘Z). Lets the helper log a transfer as Caret's rather than the user's.
///
/// Carries no field text: the helper already holds the proposed value under `proposalId` and
/// `fieldKey`. `valueLength` is the UTF-16 length of what was written, so the helper can tell a
/// verified write from a truncated one without the text.
///
/// Not yet in `helper/src/protocol.ts`; the screen track must add it there (see the A2 report).
public struct FillResult: Codable, Equatable, Sendable {
    public static let type = "fillResult"

    public enum Outcome: String, Codable, Sendable {
        /// Written and read back equal to the proposed value.
        case inserted
        /// The guard refused before anything was written: target moved, field changed, source
        /// gone, expired.
        case rejected
        /// A write was attempted and the field does not hold the expected value.
        case failed
        /// ⌘Z restored the prior value, read back.
        case undone
        /// ⌘Z was pressed but the field had changed since the write, or the revert did not verify.
        case undoFailed
    }

    public enum Method: String, Codable, Sendable {
        /// ⌘V posted to the target's pid.
        case pastePid
        /// `AXSelectedText` written on the target element, for apps that ignore a pid-posted ⌘V.
        case axSelectedText
        /// `AXValue` written on the target element (undo only).
        case axValue
    }

    public var at: Int64
    public var proposalId: String
    public var windowId: String
    public var fieldKey: String
    public var outcome: Outcome
    /// A stable short code (`InsertionGuard.Rejection.code`, `sourceChanged`, ...). Null on success.
    public var reason: String?
    public var method: Method?
    public var valueLength: Int

    public init(
        at: Int64, proposalId: String, windowId: String, fieldKey: String, outcome: Outcome,
        reason: String?, method: Method?, valueLength: Int
    ) {
        self.at = at
        self.proposalId = proposalId
        self.windowId = windowId
        self.fieldKey = fieldKey
        self.outcome = outcome
        self.reason = reason
        self.method = method
        self.valueLength = valueLength
    }

    enum CodingKeys: String, CodingKey { case type, v, at, proposalId, windowId, fieldKey, outcome, reason, method, valueLength }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        let v = try c.decode(Int.self, forKey: .v)
        guard type == Self.type else { throw ProtocolError("expected type \(Self.type), got \(type)") }
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v)") }
        at = try c.decode(Int64.self, forKey: .at)
        proposalId = try c.decode(String.self, forKey: .proposalId)
        windowId = try c.decode(String.self, forKey: .windowId)
        fieldKey = try c.decode(String.self, forKey: .fieldKey)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        // Nullable, not optional: the key must be present, as zod's `.nullable()` requires.
        guard c.contains(.reason), c.contains(.method) else { throw ProtocolError("reason and method must be present; send null") }
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        method = try c.decodeIfPresent(Method.self, forKey: .method)
        valueLength = try c.decode(Int.self, forKey: .valueLength)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(at, forKey: .at)
        try c.encode(proposalId, forKey: .proposalId)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(fieldKey, forKey: .fieldKey)
        try c.encode(outcome, forKey: .outcome)
        try c.encode(reason, forKey: .reason)
        try c.encode(method, forKey: .method)
        try c.encode(valueLength, forKey: .valueLength)
    }
}

/// Splits a byte stream into NDJSON lines. A partial line stays buffered until its newline
/// arrives; an over-long line is dropped whole and reported, so one bad message cannot grow the
/// buffer without bound or desynchronize the lines after it.
public struct LineFramer: Sendable {
    public let maxLineBytes: Int
    private var buffer = Data()
    private var discarding = false

    public init(maxLineBytes: Int = 4 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public enum Item: Equatable, Sendable {
        case line(Data)
        case oversized
    }

    public mutating func append(_ chunk: Data) -> [Item] {
        var out: [Item] = []
        var rest = chunk[...]
        while let newline = rest.firstIndex(of: 0x0A) {
            let piece = rest[rest.startIndex..<newline]
            rest = rest[rest.index(after: newline)...]
            if discarding {
                discarding = false
                buffer.removeAll()
                continue
            }
            buffer.append(contentsOf: piece)
            if buffer.count > maxLineBytes {
                out.append(.oversized)
            } else if !buffer.allSatisfy({ $0 == 0x20 || $0 == 0x0D || $0 == 0x09 }) {
                out.append(.line(buffer))
            }
            buffer.removeAll()
        }
        if !discarding {
            buffer.append(contentsOf: rest)
            if buffer.count > maxLineBytes {
                out.append(.oversized)
                buffer.removeAll()
                discarding = true
            }
        }
        return out
    }
}
