import CaretScreenCore
import Foundation

/// What the host does with one line from the helper's socket.
///
/// The wire types are the screen track's (`CaretScreenCore`, mirroring `helper/src/protocol.ts`).
/// The host acts on `fillProposal`, `error`, the broadcast `activity` and the `activityReply` to
/// its own request, the offers (`alternatives`, `action`, `popup`) and their withdrawal, and
/// `taskProgress`, which ends the working line of an accepted offer. Anything else the helper sends
/// is named and counted rather than treated as a broken connection, so a helper that adds message
/// types does not disconnect an older host.
public enum HelperInbound: Equatable, Sendable {
    case fillProposal(FillProposal)
    case error(HelperError)
    case activity(Activity)
    case activityReply(ActivityReply)
    case alternatives(OfferAlternatives)
    case action(OfferAction)
    case popup(OfferPopup)
    /// Reason `reoffered` carries `replacedBy`, the key of the offer that replaces it.
    case offerWithdrawn(OfferWithdrawn)
    case taskProgress(TaskProgress)
    /// The answer to this host's `firstLook` (`FirstLook.swift`), the host's own contract until
    /// the helper's schema has it.
    case firstLookReply(FirstLookReply)
    /// A valid protocol message that is not addressed to consumers (reader traffic, or our own
    /// requests echoed back).
    case notForConsumer(type: String)
    /// A `type` this host does not know. Newer helpers may send these.
    case unknown(type: String)

    /// The message's wire `type`, for counters.
    public var typeName: String {
        switch self {
        case .fillProposal: return FillProposal.type
        case .error: return HelperError.type
        case .activity: return Activity.type
        case .activityReply: return ActivityReply.type
        case .alternatives: return OfferAlternatives.type
        case .action: return OfferAction.type
        case .popup: return OfferPopup.type
        case .offerWithdrawn: return OfferWithdrawn.type
        case .taskProgress: return TaskProgress.type
        case .firstLookReply: return FirstLookReply.type
        case .notForConsumer(let type), .unknown(let type): return type
        }
    }

    public static func decode(_ line: Data) throws -> HelperInbound {
        let envelope = try JSONDecoder().decode(EnvelopeProbe.self, from: line)
        guard envelope.v == Proto.version else {
            throw ProtocolError("unsupported protocol version \(envelope.v) for \(envelope.type)")
        }
        switch envelope.type {
        case FillProposal.type, HelperError.type, Activity.type, ActivityReply.type, OfferAlternatives.type,
             OfferAction.type, OfferPopup.type, OfferWithdrawn.type, TaskProgress.type:
            switch try JSONDecoder().decode(Message.self, from: line) {
            case .fillProposal(let proposal): return .fillProposal(proposal)
            case .error(let error): return .error(error)
            case .activity(let activity): return .activity(activity)
            case .activityReply(let reply): return .activityReply(reply)
            case .alternatives(let offer): return .alternatives(offer)
            case .action(let offer): return .action(offer)
            case .popup(let offer): return .popup(offer)
            case .offerWithdrawn(let withdrawn): return .offerWithdrawn(withdrawn)
            case .taskProgress(let progress): return .taskProgress(progress)
            default: return .notForConsumer(type: envelope.type)
            }
        case Hello.type, FillRequest.type, "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard",
             "readerCommand", "verbResult", "userInput", "taskControl", "activityRequest", OfferAccept.type, OfferStop.type, GateSettings.type:
            // Validated, so a malformed line is still counted as undecodable.
            _ = try JSONDecoder().decode(Message.self, from: line)
            return .notForConsumer(type: envelope.type)
        case FillResult.type, FirstLookRequest.type:
            return .notForConsumer(type: envelope.type)
        case FirstLookReply.type:
            return .firstLookReply(try FirstLookReply.decode(line))
        default:
            return .unknown(type: envelope.type)
        }
    }

    private struct EnvelopeProbe: Decodable {
        let type: String
        let v: Int
    }
}

// `FillResult` (host to helper: what became of one field of a fill proposal after Tab or ⌘Z) is
// the screen track's type in CaretScreenCore since v2/screen added it to the helper's schema; the
// host's own copy was removed so the two cannot drift or collide.

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
