import Foundation

/// Wire types for the JSON-lines bridge documented in `docs/bridge-protocol.md`.
///
/// The core never observes macOS. Every field here is the app's own reading,
/// including whether a field is secure and whether Accessibility is granted, so
/// these types are the whole contract: if the app does not report a fact, the
/// core cannot know it.
///
/// Offsets are UTF-16 code units, matching `kAXSelectedTextRange`.

// MARK: - Bounds

public enum CoreLimits {
    public static let nearbyTextUnits = 4000
    public static let clipboardUnits = 2000
    public static let historyItems = 20
    public static let historyTextUnits = 1000
    public static let observations = 10
    public static let observationTextUnits = 1000
}

// MARK: - Timestamps

/// The core parses with `datetime.fromisoformat` and rejects a naive timestamp,
/// so every time we send carries an explicit offset. Whole seconds only: older
/// Python only accepts 3 or 6 fractional digits, and the core orders work by
/// `revision`, not by these stamps.
public enum CoreTimestamp {
    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    public static func string(from date: Date) -> String { formatter.string(from: date) }
    public static func date(from string: String) -> Date? { formatter.date(from: string) }
}

// MARK: - Identity

/// Which field an offer belongs to. An edit is rechecked against this before it
/// is applied.
public struct TargetIdentity: Codable, Equatable, Sendable {
    public var pid: Int32
    public var bundleID: String
    public var windowID: String
    public var elementID: String
    /// Change token for the element's value. Two snapshots sharing this token
    /// describe the same underlying text.
    public var elementRevision: String

    public init(pid: Int32, bundleID: String, windowID: String, elementID: String, elementRevision: String) {
        self.pid = pid
        self.bundleID = bundleID
        self.windowID = windowID
        self.elementID = elementID
        self.elementRevision = elementRevision
    }

    enum CodingKeys: String, CodingKey {
        case pid
        case bundleID = "bundle_id"
        case windowID = "window_id"
        case elementID = "element_id"
        case elementRevision = "element_revision"
    }
}

public struct Permissions: Codable, Equatable, Sendable {
    public var accessibility: Bool
    public var screenRecording: Bool
    public var inputMonitoring: Bool

    public init(accessibility: Bool, screenRecording: Bool = false, inputMonitoring: Bool = false) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
        self.inputMonitoring = inputMonitoring
    }

    enum CodingKeys: String, CodingKey {
        case accessibility
        case screenRecording = "screen_recording"
        case inputMonitoring = "input_monitoring"
    }
}

public struct TextSelection: Codable, Equatable, Sendable {
    public var start: Int
    public var end: Int
    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }
    public var isEmpty: Bool { end <= start }
}

/// One reading of the focused field. `nearbyText` is a bounded window starting
/// at `textOffset`; `caret` and `selection` are absolute offsets in the full
/// value. Absolute offsets mean an accepted edit names a range the app can
/// apply without re-deriving the window.
public struct InputSnapshot: Codable, Equatable, Sendable {
    public var revision: Int
    public var capturedAt: Date
    public var target: TargetIdentity
    public var role: String
    public var nearbyText: String
    public var textOffset: Int
    public var caret: Int
    public var selection: TextSelection
    public var secure: Bool
    public var imeComposing: Bool
    public var appExcluded: Bool
    public var valueLength: Int?

    public init(
        revision: Int,
        capturedAt: Date,
        target: TargetIdentity,
        role: String,
        nearbyText: String,
        textOffset: Int,
        caret: Int,
        selection: TextSelection,
        secure: Bool = false,
        imeComposing: Bool = false,
        appExcluded: Bool = false,
        valueLength: Int? = nil
    ) {
        self.revision = revision
        self.capturedAt = capturedAt
        self.target = target
        self.role = role
        self.nearbyText = nearbyText
        self.textOffset = textOffset
        self.caret = caret
        self.selection = selection
        self.secure = secure
        self.imeComposing = imeComposing
        self.appExcluded = appExcluded
        self.valueLength = valueLength
    }

    enum CodingKeys: String, CodingKey {
        case revision
        case capturedAt = "captured_at"
        case target, role
        case nearbyText = "nearby_text"
        case textOffset = "text_offset"
        case caret, selection, secure
        case imeComposing = "ime_composing"
        case appExcluded = "app_excluded"
        case valueLength = "value_length"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revision = try c.decode(Int.self, forKey: .revision)
        let raw = try c.decode(String.self, forKey: .capturedAt)
        guard let parsed = CoreTimestamp.date(from: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .capturedAt, in: c, debugDescription: "not ISO 8601 with offset")
        }
        capturedAt = parsed
        target = try c.decode(TargetIdentity.self, forKey: .target)
        role = try c.decode(String.self, forKey: .role)
        nearbyText = try c.decode(String.self, forKey: .nearbyText)
        textOffset = try c.decode(Int.self, forKey: .textOffset)
        caret = try c.decode(Int.self, forKey: .caret)
        selection = try c.decodeIfPresent(TextSelection.self, forKey: .selection)
            ?? TextSelection(start: caret, end: caret)
        secure = try c.decodeIfPresent(Bool.self, forKey: .secure) ?? false
        imeComposing = try c.decodeIfPresent(Bool.self, forKey: .imeComposing) ?? false
        appExcluded = try c.decodeIfPresent(Bool.self, forKey: .appExcluded) ?? false
        valueLength = try c.decodeIfPresent(Int.self, forKey: .valueLength)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(revision, forKey: .revision)
        try c.encode(CoreTimestamp.string(from: capturedAt), forKey: .capturedAt)
        try c.encode(target, forKey: .target)
        try c.encode(role, forKey: .role)
        try c.encode(nearbyText, forKey: .nearbyText)
        try c.encode(textOffset, forKey: .textOffset)
        try c.encode(caret, forKey: .caret)
        try c.encode(selection, forKey: .selection)
        try c.encode(secure, forKey: .secure)
        try c.encode(imeComposing, forKey: .imeComposing)
        try c.encode(appExcluded, forKey: .appExcluded)
        try c.encode(valueLength, forKey: .valueLength)
    }
}

/// Clipboard text the app has decided Caret may read. Unavailable is a
/// first-class state: `{"available": false}` rather than an empty string.
public struct ClipboardContext: Codable, Equatable, Sendable {
    public var available: Bool
    public var text: String?
    public var capturedAt: Date?

    public static let unavailable = ClipboardContext(available: false, text: nil, capturedAt: nil)

    public init(available: Bool, text: String?, capturedAt: Date?) {
        self.available = available
        self.text = text
        self.capturedAt = capturedAt
    }

    enum CodingKeys: String, CodingKey {
        case available, text
        case capturedAt = "captured_at"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(available, forKey: .available)
        // The core requires text + captured_at exactly when available is true.
        if available {
            try c.encode(text ?? "", forKey: .text)
            try c.encode(CoreTimestamp.string(from: capturedAt ?? Date()), forKey: .capturedAt)
        }
    }
}

public struct HistoryItem: Codable, Equatable, Sendable {
    public var sourceID: String
    public var capturedAt: Date
    public var text: String
    public var app: String

    public init(sourceID: String, capturedAt: Date, text: String, app: String = "") {
        self.sourceID = sourceID
        self.capturedAt = capturedAt
        self.text = text
        self.app = app
    }

    enum CodingKeys: String, CodingKey {
        case sourceID = "source_id"
        case capturedAt = "captured_at"
        case text, app
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sourceID, forKey: .sourceID)
        try c.encode(CoreTimestamp.string(from: capturedAt), forKey: .capturedAt)
        try c.encode(text, forKey: .text)
        try c.encode(app, forKey: .app)
    }
}

public struct Observation: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case observation, result }

    public var sourceID: String
    public var capturedAt: Date
    public var kind: Kind
    public var summary: String
    public var status: String

    public init(sourceID: String, capturedAt: Date, kind: Kind, summary: String, status: String = "ok") {
        self.sourceID = sourceID
        self.capturedAt = capturedAt
        self.kind = kind
        self.summary = summary
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case sourceID = "source_id"
        case capturedAt = "captured_at"
        case kind, summary, status
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sourceID, forKey: .sourceID)
        try c.encode(CoreTimestamp.string(from: capturedAt), forKey: .capturedAt)
        try c.encode(kind, forKey: .kind)
        try c.encode(summary, forKey: .summary)
        try c.encode(status, forKey: .status)
    }
}

/// A supplied context source, present or explicitly absent. A source that
/// failed belongs here with `available: false` so the judge is told what is
/// missing instead of silently seeing less context.
public struct SourceRecord: Codable, Equatable, Sendable {
    public var name: String
    public var available: Bool
    public var capturedAt: Date?
    public var detail: String

    public init(name: String, available: Bool, capturedAt: Date? = nil, detail: String = "") {
        self.name = name
        self.available = available
        self.capturedAt = capturedAt
        self.detail = detail
    }

    enum CodingKeys: String, CodingKey {
        case name, available, detail
        case capturedAt = "captured_at"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(available, forKey: .available)
        try c.encode(capturedAt.map(CoreTimestamp.string(from:)), forKey: .capturedAt)
        try c.encode(detail, forKey: .detail)
    }
}

public struct ContextFrame: Codable, Equatable, Sendable {
    public var snapshot: InputSnapshot
    public var permissions: Permissions
    public var clipboard: ClipboardContext
    public var history: [HistoryItem]
    public var observations: [Observation]
    public var sources: [SourceRecord]
    public var workflowActive: Bool

    public init(
        snapshot: InputSnapshot,
        permissions: Permissions,
        clipboard: ClipboardContext = .unavailable,
        history: [HistoryItem] = [],
        observations: [Observation] = [],
        sources: [SourceRecord] = [],
        workflowActive: Bool = false
    ) {
        self.snapshot = snapshot
        self.permissions = permissions
        self.clipboard = clipboard
        self.history = history
        self.observations = observations
        self.sources = sources
        self.workflowActive = workflowActive
    }

    enum CodingKeys: String, CodingKey {
        case snapshot, permissions, clipboard, history, observations, sources
        case workflowActive = "workflow_active"
    }
}

// MARK: - Results

public struct HelloResult: Decodable, Equatable, Sendable {
    public var protocolVersion: Int
    public var intervalSeconds: Double
    public var maxOfferAgeSeconds: Double
    public var maxInlineUnits: Int
    public var workflows: [WorkflowSummary]

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case intervalSeconds = "interval_seconds"
        case maxOfferAgeSeconds = "max_offer_age_seconds"
        case maxInlineUnits = "max_inline_units"
        case workflows
    }
}

/// Decoded loosely on purpose: the catalog belongs to the workflow owner and
/// gains fields there. We display what we recognize and ignore the rest.
public struct WorkflowSummary: Decodable, Equatable, Sendable {
    public var id: String?
    public var title: String?
    public var executionMethod: String?

    enum CodingKeys: String, CodingKey {
        case id, title
        case executionMethod = "execution_method"
    }
}

public struct ContextUpdateResult: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case admitted, coalesced, skipped }
    public var status: Status
    public var reason: String
    public var revision: Int
}

public struct InlineEdit: Decodable, Equatable, Sendable {
    public var proposalID: String
    public var status: String
    public var target: TargetIdentity
    public var replaceStart: Int
    public var replaceEnd: Int
    public var replacement: String
    public var originalDigest: String

    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id"
        case status, target
        case replaceStart = "replace_start"
        case replaceEnd = "replace_end"
        case replacement
        case originalDigest = "original_digest"
    }
}

public struct WorkflowExecution: Decodable, Equatable, Sendable {
    public var status: String
    public var summary: String
    public var evidence: [String]

    enum CodingKeys: String, CodingKey { case status, summary, evidence }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        evidence = try c.decodeIfPresent([String].self, forKey: .evidence) ?? []
    }
}

/// `offer.accept` answers with the inline edit to apply, or with the result of
/// the workflow that ran.
public enum AcceptResult: Decodable, Equatable, Sendable {
    case inline(InlineEdit)
    case action(WorkflowExecution)

    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: KindKey.self)
        let kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        if kind == "inline" {
            self = .inline(try InlineEdit(from: decoder))
        } else {
            self = .action(try WorkflowExecution(from: decoder))
        }
    }
}

public struct DismissResult: Decodable, Equatable, Sendable {
    public var dismissed: Bool
}

// MARK: - Offers and events

public enum Offer: Decodable, Equatable, Sendable {
    case inline(InlineOffer)
    case action(ActionOffer)

    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: KindKey.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "inline": self = .inline(try InlineOffer(from: decoder))
        default: self = .action(try ActionOffer(from: decoder))
        }
    }

    public var proposalID: String {
        switch self {
        case .inline(let offer): return offer.proposalID
        case .action(let offer): return offer.proposalID
        }
    }

    public var revision: Int {
        switch self {
        case .inline(let offer): return offer.revision
        case .action(let offer): return offer.revision
        }
    }

    public var target: TargetIdentity {
        switch self {
        case .inline(let offer): return offer.target
        case .action(let offer): return offer.target
        }
    }
}

public struct InlineOffer: Decodable, Equatable, Sendable {
    public var proposalID: String
    public var revision: Int
    public var target: TargetIdentity
    public var createdAt: Date
    public var replaceStart: Int
    public var replaceEnd: Int
    public var replacement: String
    public var originalDigest: String

    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id"
        case revision, target
        case createdAt = "created_at"
        case replaceStart = "replace_start"
        case replaceEnd = "replace_end"
        case replacement
        case originalDigest = "original_digest"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proposalID = try c.decode(String.self, forKey: .proposalID)
        revision = try c.decode(Int.self, forKey: .revision)
        target = try c.decode(TargetIdentity.self, forKey: .target)
        let raw = try c.decode(String.self, forKey: .createdAt)
        guard let parsed = CoreTimestamp.date(from: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .createdAt, in: c, debugDescription: "not ISO 8601 with offset")
        }
        createdAt = parsed
        replaceStart = try c.decode(Int.self, forKey: .replaceStart)
        replaceEnd = try c.decode(Int.self, forKey: .replaceEnd)
        replacement = try c.decode(String.self, forKey: .replacement)
        originalDigest = try c.decode(String.self, forKey: .originalDigest)
    }
}

public struct ActionOffer: Decodable, Equatable, Sendable {
    public var proposalID: String
    public var revision: Int
    public var target: TargetIdentity
    public var workflowID: String
    public var title: String
    public var effect: String
    public var evidence: [String]
    public var requiredInputs: [String]
    public var missingInputs: [String]
    public var executionMethod: String
    public var sampleOnly: Bool

    enum CodingKeys: String, CodingKey {
        case proposalID = "proposal_id"
        case revision, target, title, effect, evidence
        case workflowID = "workflow_id"
        case requiredInputs = "required_inputs"
        case missingInputs = "missing_inputs"
        case executionMethod = "execution_method"
        case sampleOnly = "sample_only"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        proposalID = try c.decode(String.self, forKey: .proposalID)
        revision = try c.decode(Int.self, forKey: .revision)
        target = try c.decode(TargetIdentity.self, forKey: .target)
        workflowID = try c.decodeIfPresent(String.self, forKey: .workflowID) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        effect = try c.decodeIfPresent(String.self, forKey: .effect) ?? ""
        evidence = try c.decodeIfPresent([String].self, forKey: .evidence) ?? []
        requiredInputs = try c.decodeIfPresent([String].self, forKey: .requiredInputs) ?? []
        missingInputs = try c.decodeIfPresent([String].self, forKey: .missingInputs) ?? []
        executionMethod = try c.decodeIfPresent(String.self, forKey: .executionMethod) ?? ""
        sampleOnly = try c.decodeIfPresent(Bool.self, forKey: .sampleOnly) ?? false
    }
}

/// An unsolicited line with no `id`. `invalidated` means a visible offer stopped
/// being valid and its preview should come down. `failed` means a provider
/// failed: show nothing and do not retry, because the next context change
/// schedules the next attempt by itself.
public enum CoreEvent: Equatable, Sendable {
    case offer(Offer)
    case abstain(revision: Int, reason: String)
    case invalidated(proposalID: String, reason: String)
    case discarded(revision: Int, reason: String)
    case failed(revision: Int, reason: String)
    /// A line we parsed as an event but whose name this build does not know.
    /// Kept rather than dropped so an unknown event is visible in diagnostics.
    case unknown(name: String)
}

// MARK: - Errors

public struct CoreErrorPayload: Decodable, Equatable, Sendable {
    public var code: String
    public var message: String
}

public enum BridgeError: Error, Equatable {
    /// A coded failure from the core: `invalid_json`, `invalid_request`,
    /// `invalid_context`, `unknown_method`, `acceptance_rejected`,
    /// `workflow_error` or `provider_error`.
    case core(code: String, message: String)
    case notRunning
    case alreadyRunning
    case launchFailed(String)
    case processExited(status: Int32, reason: String)
    case malformedReply(String)
    case cancelled
}

extension BridgeError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .core(let code, let message): return "core error \(code): \(message)"
        case .notRunning: return "the core process is not running"
        case .alreadyRunning: return "the core process is already running"
        case .launchFailed(let detail): return "could not launch the core process: \(detail)"
        case .processExited(let status, let reason): return "the core process exited (\(status)): \(reason)"
        case .malformedReply(let detail): return "malformed reply: \(detail)"
        case .cancelled: return "the request was cancelled"
        }
    }
}
