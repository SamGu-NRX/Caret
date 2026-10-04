import CaretScreenCore
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
        /// The field a pid paste landed in instead of the approved one, by its label (S1 audit #13).
        public var strayField: String?
        /// What the pasteboard reconcile did after a paste: `restored`, `skippedUserCopied` (someone
        /// copied after Caret wrote, and their copy stays), `raced` or `notWritten`. Nil when the
        /// write did not use the pasteboard.
        public var clipboard: String?
        /// Types of the user's clipboard Caret could not read before pasting, so its restore could not
        /// bring them back ("item 2: public.file-url"). Nil or empty when every type was read.
        public var clipboardLost: [String]?

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
        /// `activity` and `activityReply` messages received.
        public var activity: UInt64 = 0
        /// `alternatives`, `action` and `popup` messages received.
        public var offers: UInt64 = 0
        public var withdrawals: UInt64 = 0
        public var progress: UInt64 = 0
        /// `firstLookReply` messages received.
        public var firstLookReplies: UInt64 = 0
        /// `memoryReply` messages received.
        public var memoryReplies: UInt64 = 0
        /// `planRequest` lines written from the ask field, and `planProposal` answers received.
        public var planRequests: UInt64 = 0
        public var planProposals: UInt64 = 0
        /// `skillOffer` questions received, and `skillAnswer` lines written (B19).
        public var skillOffers: UInt64 = 0
        public var skillAnswers: UInt64 = 0
        /// Lines written as `offerAccept` and `offerStop`, counted again in `resultsSent`.
        public var accepts: UInt64 = 0
        public var stops: UInt64 = 0
        /// `settings` lines written: after each hello, and on each change of roles, level or pause.
        public var settingsSent: UInt64 = 0
        public var errors: UInt64 = 0
        /// The helper's last error text: window ids and reasons, never screen text.
        public var lastError: String?
        /// Messages that were valid but not for a consumer, or of a type this host does not know.
        public var skipped: [String: UInt64] = [:]
        public var undecodable: UInt64 = 0
        /// Lines written to the socket (fillResult, offerAccept, taskControl, activityRequest),
        /// dropped while disconnected, and fillResults answered with "invalid consumer message".
        public var resultsSent: UInt64 = 0
        public var resultsDropped: UInt64 = 0
        public var resultsRejected: UInt64 = 0

        public init() {}
    }

    public struct Toast: Codable, Equatable, Sendable {
        /// `done`, `undone` or `error`; `undoing` while the helper undoes a fill pop-up's task.
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
        /// Where the line went: `above` or `below` the field, with `,compact` for the 20 pt line.
        public var placement: String?
        /// An offer's line is waiting for the toast before it to end (`FillLineRule.deferLine`).
        public var lineDeferred: Bool?

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

    /// Alternatives, action lines, pop-ups and the lines after an accepted action.
    /// A line its watch took down: the gate's answer and, when covered, the window over the anchor
    /// and whether the app's focused frame could be read at that moment.
    public struct LineHidden: Codable, Equatable, Sendable {
        public var hold: String
        public var coverPID: Int32?
        public var coverLayer: Int?
        public var coverAgent: Bool?
        public var coverBounds: [Double]?
        public var focusedFrameRead: Bool?

        public init(hold: String, coverPID: Int32? = nil, coverLayer: Int? = nil, coverAgent: Bool? = nil, coverBounds: [Double]? = nil, focusedFrameRead: Bool? = nil) {
            self.hold = hold
            self.coverPID = coverPID
            self.coverLayer = coverLayer
            self.coverAgent = coverAgent
            self.coverBounds = coverBounds
            self.focusedFrameRead = focusedFrameRead
        }
    }

    public struct SurfaceInfo: Codable, Equatable, Sendable {
        /// The host runs with `--surfaces headless`: offers are decided, never drawn.
        public var headless: Bool?
        /// System Settings' Reduce Motion as the host reads it, when it draws.
        public var reduceMotion: Bool?
        public var offerId: UInt64?
        /// The helper's key for the shown offer.
        public var offerKey: String?
        /// `ghost` (alternatives), `action` or `popup`.
        public var kind: String?
        public var source: String?
        public var candidates: [String]?
        /// The arbiter's navigation state for the shown offer.
        public var ui: OfferUI?
        /// The ghost text drawn at the caret (model or injected output, never field text).
        public var ghost: String?
        /// The ghost text's own panel, when Caret drew it (KeyType's renderer had no placement).
        public var ghostPanel: Panel?
        public var panel: Panel?
        /// How the panel was placed around its field (`FieldPanelPlacement`).
        public var panelPlacement: PanelPlacementInfo?
        public var decor: Panel?
        public var list: Panel?
        public var figure: String?
        public var character: String?
        public var lineText: String?
        /// Seconds the accepted work has run.
        public var working: Double?
        /// The offer key (and helper task id) of the accepted work.
        public var workingOn: String?
        /// The work was started by a skill with no Tab (B19).
        public var unprompted: Bool?
        /// Why a working or result line was last taken down by its watch.
        public var lineHidden: LineHidden?
        /// The keep or promote question under the result line, as its row reads (asked or answered).
        public var question: String?
        public var questionAnswered: Bool?
        /// The fill pop-up's toast, and what its undo did.
        public var toast: Toast?
        /// An injected offer waiting for its field to be where the user is looking
        /// (`SurfaceGate.Hold`), drawn nowhere meanwhile.
        public var held: String?
        public var lastAccepted: AcceptInfo?

        public init() {}
    }

    public struct PanelPlacementInfo: Codable, Equatable, Sendable {
        /// below, above, belowNarrow, aboveNarrow, right or left.
        public var spot: String
        /// Square points of the app's elements under the panel when placed; nil when no spot fit
        /// on screen.
        public var overlap: Double?
        /// Candidate frames hit-tested before one was chosen.
        public var probed: Int
        /// Measuring and hit-testing, on the main thread.
        public var milliseconds: Double
        /// The field it was placed around, global top-left.
        public var field: [Double]

        public init(spot: String, overlap: Double?, probed: Int, milliseconds: Double, field: [Double]) {
            self.spot = spot
            self.overlap = overlap
            self.probed = probed
            self.milliseconds = milliseconds
            self.field = field
        }
    }

    public struct AcceptInfo: Codable, Equatable, Sendable {
        public var offerKey: String?
        public var actionId: String?
        public var candidate: Int?
        public var row: Int?
        public var overrides: [String: Int]?
        public var source: String
        public var kind: String

        public init(offerKey: String?, actionId: String?, candidate: Int?, row: Int?, overrides: [String: Int]?, source: String, kind: String) {
            self.offerKey = offerKey
            self.actionId = actionId
            self.candidate = candidate
            self.row = row
            self.overrides = overrides
            self.source = source
            self.kind = kind
        }
    }

    /// The debug socket's `settings` reply: the file, the choices, and the gate they make.
    public struct SettingsInfo: Codable, Equatable, Sendable {
        public var path: String
        /// Set when the file exists but could not be read, or could not be written.
        public var error: String?
        public var settings: CaretSettings
        public var gate: GatePolicy

        public init(path: String, error: String?, settings: CaretSettings, gate: GatePolicy) {
            self.path = path
            self.error = error
            self.settings = settings
            self.gate = gate
        }
    }

    /// The debug socket's `onboarding` reply (`OnboardingFlow.debugInfo`).
    public struct OnboardingInfo: Codable, Equatable, Sendable {
        public struct TryItInfo: Codable, Equatable, Sendable {
            /// The staged field's text: the synthetic sample value, or what the run typed.
            public var value: String
            public var offerVisible: Bool
            public var completed: Bool
            public var declined: Bool
            public var tabs: Int
        }

        public var step: String
        /// The step's place among the steps this flow shows (`stepCount` of them).
        public var stepIndex: Int
        public var stepCount: Int?
        /// The `know` step is in the flow (the helper keeps typed values).
        public var showsKnow: Bool?
        public var roles: [String]
        public var level: String
        public var canContinue: Bool
        public var finished: Bool
        public var permissions: OnboardingPermissions?
        public var showsInputMonitoring: Bool?
        public var advancingAfterGrant: Bool?
        public var tryIt: TryItInfo?
        /// The `know` screen: how long each typed value is (never the value), and the problem
        /// Continue showed.
        public var about: [String: Int]?
        public var aboutProblem: String?
        /// `idle`, `asking`, `found`, `nothing` or `failed`.
        public var firstLook: String?
        public var firstLookRequest: String?
        public var firstLookKind: String?
        public var firstLookTitle: String?
        public var firstLookError: String?
        /// The keys the found offer or its line take now: `tab`, `cmd-1`, `cmd-z`, `esc`.
        public var firstLookKeys: [String]?
        /// The taken offer's phase (`FirstLookRun.Phase.name`) and its line, as the pebble says it.
        public var firstLookRun: String?
        public var firstLookLine: String?
        /// The window is on screen. False on a run with `--onboarding hidden`.
        public var windowShown: Bool?
        /// What a flow without a window did not do (`openSystemSettings.accessibility`).
        public var suppressed: [String]?

        public init(step: String, stepIndex: Int, roles: [String], level: String, canContinue: Bool, finished: Bool) {
            self.step = step
            self.stepIndex = stepIndex
            self.roles = roles
            self.level = level
            self.canContinue = canContinue
            self.finished = finished
        }
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
        /// The listen-only mouse tap exists (clicks can pause a run), and the clicks it saw.
        public var mouseTap: Bool?
        public var mouseDowns: UInt64?

        public init(
            running: Bool, enabled: Bool, keyDowns: UInt64, consumed: UInt64,
            timeoutRecoveries: UInt64, maxCallbackMicros: Double, p99CallbackMicros: Double?,
            targetFromEvent: UInt64? = nil, targetMissing: UInt64? = nil,
            mouseTap: Bool? = nil, mouseDowns: UInt64? = nil
        ) {
            self.mouseTap = mouseTap
            self.mouseDowns = mouseDowns
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
    public var surface: SurfaceInfo?
    /// How each app took a write, by bundle id or `exe:` name: `pastePid` for apps that refused or
    /// ignored `AXSelectedText` (A17); an app not listed takes AX writes.
    public var writeMethods: [String: String]?
    /// How many times the host's write authorization was ended, and why the last time (`paused`,
    /// `stop`, `takeOver`, `pause`, `helperDisconnected`).
    public var authorityRevokes: Int?
    public var authorityLastRevoke: String?
    /// The ghost overlay's recent attempts to draw a completion, oldest first: how each fit, or
    /// why it was not drawn, with the room it had. Geometry only, never text.
    public var ghostFits: [GhostFit.Record]?

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
