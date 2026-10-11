import Foundation

/// What the host's debug socket answers (H12, lead decision 4).
///
/// The socket is mode 0600 in a 0700 folder, so only the user's own processes reach it, but that is every process the
/// user runs, and the shipped Caret runs at each login. A release build therefore answers only `state` and `spend`, and
/// its `state` is `ReleaseState`, which the host builds itself. Everything else (`click`, `settings set`, `ask submit`,
/// `inject` and the rest) needs a development build or the explicit opt-in `CARET_DEBUG_SOCKET=full`, which is how the
/// test Mac's harnesses keep driving a release build.
public enum DebugSocketAccess: String, Sendable, Equatable {
    /// Every command, as before H12: development and acceptance builds, or `CARET_DEBUG_SOCKET=full`.
    case full
    /// `state` (as `ReleaseState`) and `spend` only.
    case release

    public static let environmentKey = "CARET_DEBUG_SOCKET"

    /// `developmentBuild`: a debug or acceptance build (main.swift decides by compile flags). `CARET_DEBUG_SOCKET=full`
    /// opens a release build; `CARET_DEBUG_SOCKET=release` restricts a development one, so the release rules can be
    /// tried on a debug build. Any other value is refused by name rather than read as either.
    public static func resolve(developmentBuild: Bool, environment: [String: String]) throws -> DebugSocketAccess {
        switch environment[environmentKey] {
        case nil, "": return developmentBuild ? .full : .release
        case "full": return .full
        case "release": return .release
        case let other?: throw Problem(value: other)
        }
    }

    public struct Problem: Error, CustomStringConvertible, Equatable {
        public let value: String
        public var description: String { "\(DebugSocketAccess.environmentKey) is '\(value)'; it takes full or release" }
    }

    /// The commands a release build answers.
    public static let releaseCommands: Set<String> = ["state", "spend"]

    /// Why the socket refuses `words`, as the JSON line it sends back, or nil when it answers. An empty request means
    /// `state` (DebugStateSocket).
    public func refusal(_ words: [String]) -> String? {
        guard self == .release else { return nil }
        let verb = words.first ?? "state"
        guard !Self.releaseCommands.contains(verb) || words.count > 1 else { return nil }
        return #"{"error":"this build of Caret answers only state and spend on its debug socket; set \#(Self.environmentKey)=full to open the rest"}"#
    }
}

/// The `state` a release build's debug socket returns: an allowlist of `DebugState`, field by field. Kept are numbers,
/// switches, bundle ids and code-chosen words. Left out is everything that is or could be the user's text: offer
/// and inserted text, typed text, field digests (a short value can be recovered from its digest by trying candidates),
/// source captions, window titles, panels' text, file paths and the model file's name.
///
/// A field added to `DebugState` does not appear here until someone adds it on purpose, which is the point of building
/// a separate type rather than blanking fields of the full one.
public struct ReleaseState: Codable, Equatable, Sendable {
    public var schema = DebugState.schemaVersion
    public var build = "release"
    public var pid: Int32
    public var uptimeSeconds: Double
    public var trust: DebugState.Trust
    /// `loading`, `ready`, `disabled`, `unavailable`; never the detail or the model file, which can hold paths.
    public var engine: String
    public var focus: Focus?
    public var offer: Offer?
    public var lastClaim: Claim?
    public var lastInsertion: Insertion?
    public var tap: DebugState.Tap
    public var latency: LatencyRecorder.Summary
    public var breakpointLatency: LatencyRecorder.Summary?
    /// Only the counters in `keptCounters`. Many counter names end in a reason or a type the code builds from
    /// what it was given (a ghost replay's reason, a helper message's type), so a name is no proof the text is the
    /// code's own (H12 review).
    public var counters: [String: UInt64]
    public var helper: Helper?
    public var spend: HelperSpend?
    public var otherTabOwners: [String]?

    public struct Focus: Codable, Equatable, Sendable {
        public var pid: Int32
        public var bundleID: String
        /// One of `knownRoles`, or `other`: the role is what the focused app says it is, so it is mapped, not copied.
        public var role: String?
    }

    /// Counters a release state keeps, by exact name.
    public static let keptCounters: Set<String> = [
        "offers.published", "offers.claimed", "offers.refused", "offer.refused", "tap.createFailed", "insertion.stray",
        "ghost.overflowCapsule", "routing.rehello", "routing.rehelloDeferred", "fill.undoTaskUnsent", "fill.fillAllUnsent",
    ]

    /// Accessibility roles of the fields Caret works in. Any other role is reported as `other`.
    public static let knownRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField", "AXWebArea", "AXStaticText", "AXGroup",
    ]

    public struct Offer: Codable, Equatable, Sendable {
        public var id: UInt64
        public var kind: String?
        public var presentation: String?
        public var pid: Int32
        public var bundleID: String
        public var ageMs: Double
    }

    public struct Claim: Codable, Equatable, Sendable {
        public var claimID: UInt64
        public var offerID: UInt64
        public var claimedAt: Date
        public var outcome: String
    }

    public struct Insertion: Codable, Equatable, Sendable {
        public var claimID: UInt64
        public var ok: Bool
        public var verified: Bool?
        public var kind: String?
        public var method: String?
        public var durationMs: Double
    }

    /// The helper link's counts. `lastError` and the per-type `skipped` map are left out: both carry the helper's words.
    public struct Helper: Codable, Equatable, Sendable {
        public var connected: Bool
        public var connects: UInt64
        public var offers: UInt64
        public var proposals: UInt64
        public var withdrawals: UInt64
        public var errors: UInt64
        public var undecodable: UInt64
    }

    /// The outcome's case only; a rejection's or a failure's reason stays out.
    static func name(_ outcome: OfferArbiter.ClaimOutcome) -> String {
        switch outcome {
        case .pending: return "pending"
        case .rejected: return "rejected"
        case .approved: return "approved"
        case .inserted: return "inserted"
        case .insertFailed: return "insertFailed"
        case .accepted: return "accepted"
        }
    }

    public init(_ s: DebugState) {
        pid = s.pid
        uptimeSeconds = s.uptimeSeconds
        trust = s.trust
        engine = s.engine.state
        focus = s.focus.map { Focus(pid: $0.pid, bundleID: $0.bundleID, role: $0.role.map { Self.knownRoles.contains($0) ? $0 : "other" }) }
        offer = s.offer.map { Offer(id: $0.id, kind: $0.kind, presentation: $0.presentation, pid: $0.pid, bundleID: $0.bundleID, ageMs: $0.ageMs) }
        lastClaim = s.lastClaim.map { Claim(claimID: $0.claimID, offerID: $0.offerID, claimedAt: $0.claimedAt, outcome: Self.name($0.outcome)) }
        lastInsertion = s.lastInsertion.map {
            Insertion(claimID: $0.claimID, ok: $0.ok, verified: $0.verified, kind: $0.kind, method: $0.method, durationMs: $0.durationMs)
        }
        tap = s.tap
        latency = s.latency
        breakpointLatency = s.breakpointLatency
        counters = s.counters.filter { Self.keptCounters.contains($0.key) }
        helper = s.helper.map {
            Helper(connected: $0.connected, connects: $0.connects, offers: $0.offers, proposals: $0.proposals,
                   withdrawals: $0.withdrawals, errors: $0.errors, undecodable: $0.undecodable)
        }
        spend = s.spend
        otherTabOwners = s.otherTabOwners
    }
}
