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
        /// `inline` or `capsule`.
        public var presentation: String?
    }

    public struct Insertion: Codable, Equatable, Sendable {
        public var claimID: UInt64
        public var ok: Bool
        public var error: String?
        public var text: String
        public var durationMs: Double
        /// The field reread after insertion equals the guard's predicted value.
        public var verified: Bool?
    }

    public struct Tap: Codable, Equatable, Sendable {
        public var running: Bool
        public var enabled: Bool
        public var keyDowns: UInt64
        public var consumed: UInt64
        public var timeoutRecoveries: UInt64
        public var maxCallbackMicros: Double
        public var p99CallbackMicros: Double?
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
}
