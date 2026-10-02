import Foundation

/// The JSON the debug socket returns. Tests and the lead read host state from here instead of from
/// pixels.
///
/// Privacy: field contents never appear. Focus and offers carry digests and lengths of the field
/// value; the only text included is model output (the offer and what was inserted).
public struct DebugState: Codable, Equatable, Sendable {
    public static let schemaVersion = 1

    public struct Trust: Codable, Equatable, Sendable {
        /// `AXIsProcessTrusted()`.
        public var accessibility: Bool
        /// `CGPreflightListenEventAccess()`: may observe key events.
        public var listenEvents: Bool
        /// `CGPreflightPostEventAccess()`: may synthesize the paste keystroke.
        public var postEvents: Bool
        /// The key tap was created and is currently enabled.
        public var eventTap: Bool
        public var all: Bool { accessibility && listenEvents && postEvents && eventTap }

        public init(accessibility: Bool, listenEvents: Bool, postEvents: Bool, eventTap: Bool) {
            self.accessibility = accessibility
            self.listenEvents = listenEvents
            self.postEvents = postEvents
            self.eventTap = eventTap
        }

        enum CodingKeys: String, CodingKey { case accessibility, listenEvents, postEvents, eventTap, all }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            accessibility = try c.decode(Bool.self, forKey: .accessibility)
            listenEvents = try c.decode(Bool.self, forKey: .listenEvents)
            postEvents = try c.decode(Bool.self, forKey: .postEvents)
            eventTap = try c.decode(Bool.self, forKey: .eventTap)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(accessibility, forKey: .accessibility)
            try c.encode(listenEvents, forKey: .listenEvents)
            try c.encode(postEvents, forKey: .postEvents)
            try c.encode(eventTap, forKey: .eventTap)
            try c.encode(all, forKey: .all)
        }
    }

    public struct Engine: Codable, Equatable, Sendable {
        /// `loading`, `ready` or `unavailable`.
        public var state: String
        public var detail: String?
        public var modelFile: String?
        public init(state: String, detail: String? = nil, modelFile: String? = nil) {
            self.state = state
            self.detail = detail
            self.modelFile = modelFile
        }
    }

    public struct Focus: Codable, Equatable, Sendable {
        public var pid: Int32
        public var bundleID: String
        public var role: String?
        public var caretUTF16: Int?
        public var valueLength: Int
        public var valueDigest: String

        public init(pid: Int32, bundleID: String, role: String?, caretUTF16: Int?, valueLength: Int, valueDigest: String) {
            self.pid = pid
            self.bundleID = bundleID
            self.role = role
            self.caretUTF16 = caretUTF16
            self.valueLength = valueLength
            self.valueDigest = valueDigest
        }
    }

    public struct OfferInfo: Codable, Equatable, Sendable {
        public var id: UInt64
        public var text: String
        public var typedSinceOffer: String
        public var ageMs: Double
        public var pid: Int32
        public var bundleID: String
        public var caretUTF16: Int
        public var elementRevision: String
        /// `inline`, `capsule` or `mirror`.
        public var presentation: String?
        /// `ghost` or `fill`.
        public var kind: String?
        /// Set for a fill offer.
        public var fill: FillInfo?

        public init(
            id: UInt64, text: String, typedSinceOffer: String, ageMs: Double, pid: Int32,
            bundleID: String, caretUTF16: Int, elementRevision: String, presentation: String?
        ) {
            self.id = id
            self.text = text
            self.typedSinceOffer = typedSinceOffer
            self.ageMs = ageMs
            self.pid = pid
            self.bundleID = bundleID
            self.caretUTF16 = caretUTF16
            self.elementRevision = elementRevision
            self.presentation = presentation
        }
    }

    public struct Insertion: Codable, Equatable, Sendable {
        public var claimID: UInt64
        public var ok: Bool
        public var error: String?
        public var text: String
        public var durationMs: Double
        /// The field reread after insertion equals the guard's predicted value.
        public var verified: Bool?
        /// `ghost` or `fill`.
        public var kind: String?
        /// `pastePid` or `axSelectedText`.
        public var method: String?
        /// The app ignored a pid-posted paste and the write fell back to AX.
        public var fellBack: Bool?
        /// After the fallback, a late paste doubled the text and was set back.
        public var repairedLatePaste: Bool?

        public init(claimID: UInt64, ok: Bool, error: String?, text: String, durationMs: Double, verified: Bool?) {
            self.claimID = claimID
            self.ok = ok
            self.error = error
            self.text = text
            self.durationMs = durationMs
            self.verified = verified
        }
    }

    public struct FillInfo: Codable, Equatable, Sendable {
        public var proposalId: String
        public var windowId: String
        public var fieldKey: String
        /// The caption on screen, such as "from Caret Fixture, Reference".
        public var source: String

        public init(proposalId: String, windowId: String, fieldKey: String, source: String) {
            self.proposalId = proposalId
            self.windowId = windowId
            self.fieldKey = fieldKey
            self.source = source
        }
    }

    /// The consumer connection to the helper's socket.
    public struct HelperLink: Codable, Equatable, Sendable {
        public var connected = false
        public var connects: UInt64 = 0
        public var proposals: UInt64 = 0
        public var errors: UInt64 = 0
        /// The helper's last error text: window ids and reasons, never screen text.
        public var lastError: String?
        /// Messages that were valid but not for a consumer, or of a type this host does not know.
        public var skipped: [String: UInt64] = [:]
        public var undecodable: UInt64 = 0
        /// fillResult lines written to the socket, written while disconnected, and answered by the
        /// helper with "invalid consumer message".
        public var resultsSent: UInt64 = 0
        public var resultsDropped: UInt64 = 0
        public var resultsRejected: UInt64 = 0

        public init() {}
    }

    public struct Toast: Codable, Equatable, Sendable {
        /// `done`, `undone` or `error`.
        public var kind: String
        public var caption: String
        /// Set while ⌘Z can still revert the write.
        public var grantID: UInt64?

        public init(kind: String, caption: String, grantID: UInt64?) {
            self.kind = kind
            self.caption = caption
            self.grantID = grantID
        }
    }

    /// One of the host's overlay panels, for tests: where it is and that it never took key.
    public struct Panel: Codable, Equatable, Sendable {
        /// The window server's id, usable with `screencapture -l`.
        public var windowNumber: Int
        /// Global points, top-left origin, like Accessibility frames.
        public var frame: [Double]
        public var isKey: Bool
        public var text: String?

        public init(windowNumber: Int, frame: [Double], isKey: Bool, text: String?) {
            self.windowNumber = windowNumber
            self.frame = frame
            self.isKey = isKey
            self.text = text
        }
    }

    public struct Overlay: Codable, Equatable, Sendable {
        public var ghost: Panel?
        public var line: Panel?
        public var toast: Panel?

        public init(ghost: Panel? = nil, line: Panel? = nil, toast: Panel? = nil) {
            self.ghost = ghost
            self.line = line
            self.toast = toast
        }
    }

    public struct FillStatus: Codable, Equatable, Sendable {
        /// Proposals held for windows the user may still move through.
        public var cachedProposals = 0
        public var lastProposalID: String?
        public var lastProposalFields: Int?
        /// Fields of the last proposal that carry a value (not "none").
        public var lastProposalValues: Int?
        /// Why the last evaluation showed no offer (`FillSelection.Skip`, or `notAllowed`).
        public var lastSkip: String?
        public var lastResult: FillResult?
        public var toast: Toast?
        public var overlay: Overlay?
        public var offersShown: UInt64 = 0
        /// Proposal received to fill offer published, for offers made on a proposal's arrival.
        public var proposalToOffer: LatencyRecorder.Summary?
        /// Focus notification in the form's app to fill offer published, for later fields of a
        /// proposal already held.
        public var focusToOffer: LatencyRecorder.Summary?

        public init() {}
    }

    public struct UndoInfo: Codable, Equatable, Sendable {
        public var grantID: UInt64
        public var ok: Bool
        public var error: String?

        public init(grantID: UInt64, ok: Bool, error: String?) {
            self.grantID = grantID
            self.ok = ok
            self.error = error
        }
    }

    public struct Tap: Codable, Equatable, Sendable {
        public var running: Bool
        public var enabled: Bool
        public var keyDowns: UInt64
        public var consumed: UInt64
        public var timeoutRecoveries: UInt64
        public var maxCallbackMicros: Double
        public var p99CallbackMicros: Double?
        /// Keys whose event named the receiving pid, and keys whose event did not (those take nothing).
        public var targetFromEvent: UInt64?
        public var targetMissing: UInt64?

        public init(
            running: Bool, enabled: Bool, keyDowns: UInt64, consumed: UInt64,
            timeoutRecoveries: UInt64, maxCallbackMicros: Double, p99CallbackMicros: Double?,
            targetFromEvent: UInt64? = nil, targetMissing: UInt64? = nil
        ) {
            self.targetFromEvent = targetFromEvent
            self.targetMissing = targetMissing
            self.running = running
            self.enabled = enabled
            self.keyDowns = keyDowns
            self.consumed = consumed
            self.timeoutRecoveries = timeoutRecoveries
            self.maxCallbackMicros = maxCallbackMicros
            self.p99CallbackMicros = p99CallbackMicros
        }
    }

    public var schema = DebugState.schemaVersion
    public var pid: Int32
    public var uptimeSeconds: Double
    public var trust: Trust
    public var engine: Engine
    public var focus: Focus?
    public var offer: OfferInfo?
    public var lastClaim: OfferArbiter.ClaimRecord?
    public var lastInsertion: Insertion?
    public var tap: Tap
    /// Keystroke (seen by the tap) to ghost-text paint, for paints caused by a keystroke.
    public var latency: LatencyRecorder.Summary
    public var counters: [String: UInt64]
    public var helper: HelperLink?
    public var fill: FillStatus?
    public var lastUndo: UndoInfo?
    /// Apps that ignored a pid-posted paste and now take AX writes, by bundle id or `exe:` name.
    public var writeMethods: [String: String]?

    public init(
        pid: Int32, uptimeSeconds: Double, trust: Trust, engine: Engine, focus: Focus?, offer: OfferInfo?,
        lastClaim: OfferArbiter.ClaimRecord?, lastInsertion: Insertion?, tap: Tap,
        latency: LatencyRecorder.Summary, counters: [String: UInt64]
    ) {
        self.pid = pid
        self.uptimeSeconds = uptimeSeconds
        self.trust = trust
        self.engine = engine
        self.focus = focus
        self.offer = offer
        self.lastClaim = lastClaim
        self.lastInsertion = lastInsertion
        self.tap = tap
        self.latency = latency
        self.counters = counters
    }
}
