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
        /// Set for a writing offer.
        public var writing: WritingOfferInfo?

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

    /// A writing offer as the arbiter holds it: where the fix goes and what the rows are, without
    /// the field's text.
    public struct WritingOfferInfo: Codable, Equatable, Sendable {
        /// `line` or `expanded`.
        public var presentation: String
        public var activeStart: Int
        public var activeEnd: Int
        public var marks: Int
        /// `fix`, `original` or `fixAll`, in row order.
        public var rows: [String]
        public var current: Int
        public var ownsTab: Bool
        public var needsChoice: Bool

        public init(_ offer: WritingOffer) {
            switch offer.presentation {
            case .mark: presentation = "mark"
            case .line: presentation = "line"
            case .expanded: presentation = "expanded"
            }
            activeStart = offer.active.span.start
            activeEnd = offer.active.span.end
            marks = offer.marks.count
            rows = offer.alternatives.map {
                switch $0.kind {
                case .fix: return "fix"
                case .original: return "original"
                case .fixAll: return "fixAll"
                }
            }
            current = offer.current
            ownsTab = offer.ownsTab
            needsChoice = offer.active.needsChoice
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
        /// What the pasteboard reconcile did after a paste (`ReconcilingClipboard.Outcome.name`):
        /// `restored` (a fresh read matched the saved clipboard type for type and byte for byte),
        /// `skippedUserCopied` (someone copied after Caret wrote, and their copy stays), `notRestored`
        /// (see `clipboardLost`) or `notWritten`. Nil when the write did not use the pasteboard.
        public var clipboard: String?
        /// With `notRestored`: what of the user's clipboard did not come back, entry by entry, types
        /// and sizes only ("item 2: missing (public.file-url)"). Nil otherwise.
        public var clipboardLost: [String]?
        /// Why the clipboard refused the paste route for this write (`ReconcilingClipboard.refusals`),
        /// so the write took the AX route or handed off instead. Nil when it did not refuse.
        public var clipboardRefused: [String]?
        /// The types of each clipboard item the check read, names only. Nil when the clipboard was
        /// not read.
        public var clipboardTypes: [[String]]?

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
        /// Whether the helper accepted this Caret's host proof on the current connection (`HostAuth`); nil for a Caret
        /// with no host key, which the helper serves as any other consumer.
        public var hostAuthenticated: Bool?
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
        /// M1: where the noticed facts behind an offer or a plan came from.
        public var provenances: UInt64 = 0
        /// W2: the helper's word on whether Caret can see a browser's pages (`PageSight`).
        public var pageEngine: UInt64 = 0
        /// H5: answers to the host's `fileConfirm`.
        public var fileConfirmReplies: UInt64 = 0
        /// H8: the helper's spend totals received.
        public var spend: UInt64 = 0
        /// H10: the helper's word on which page field the user is in (`PageFocusBook`).
        public var pageFields: UInt64 = 0
        /// H11: goal messages for the page task panel, local-text requests answered unavailable, and saved-answer
        /// offers and replies.
        public var goalProgress: UInt64 = 0
        public var localTextRequests: UInt64 = 0
        public var answerSaves: UInt64 = 0
        /// H13: answers to this host's pageInsert.
        public var pageInserts: UInt64 = 0
        /// H14: fileSaveOffer, fileSaveReply and savedFilesReply.
        public var files: UInt64 = 0
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
        /// H6: `routingContext` lines written, and `routeDecision` messages received.
        public var routingContexts: UInt64 = 0
        public var routeDecisions: UInt64 = 0
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
        /// H14, a panel whose content takes clicks (`HostedPanel.clickableContent`): whether it takes them now (the
        /// pointer is over its content), how many pointer monitors run, and how many mouse moves they have seen.
        public var takesClicks: Bool?
        public var pointerMonitors: Int?
        public var pointerMoves: Int?

        public init(windowNumber: Int, frame: [Double], isKey: Bool, text: String?, takesClicks: Bool? = nil, pointerMonitors: Int? = nil, pointerMoves: Int? = nil) {
            self.windowNumber = windowNumber
            self.frame = frame
            self.isKey = isKey
            self.text = text
            self.takesClicks = takesClicks
            self.pointerMonitors = pointerMonitors
            self.pointerMoves = pointerMoves
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
        /// The covering window's number (`screencapture -l` takes it), its owner's name and bundle id.
        public var coverNumber: Int?
        public var coverOwner: String?
        public var coverBundle: String?
        /// The anchor point the gate found covered, global top-left points.
        public var anchor: [Double]?

        public init(hold: String, coverPID: Int32? = nil, coverLayer: Int? = nil, coverAgent: Bool? = nil, coverBounds: [Double]? = nil, focusedFrameRead: Bool? = nil) {
            self.hold = hold
            self.coverPID = coverPID
            self.coverLayer = coverLayer
            self.coverAgent = coverAgent
            self.coverBounds = coverBounds
            self.focusedFrameRead = focusedFrameRead
        }

        /// The record of `cover` over `anchor`; `bundle` is looked up by the caller, which can ask
        /// the running applications.
        public static func covered(by cover: SurfaceGate.Window?, at anchor: CGPoint?, bundle: String? = nil, focusedFrameRead: Bool? = nil) -> LineHidden {
            var hidden = LineHidden(
                hold: SurfaceGate.Hold.covered.rawValue, coverPID: cover?.pid, coverLayer: cover?.layer, coverAgent: cover?.agent,
                coverBounds: cover.map { [$0.bounds.minX, $0.bounds.minY, $0.bounds.width, $0.bounds.height].map(Double.init) },
                focusedFrameRead: focusedFrameRead
            )
            hidden.coverNumber = cover?.number
            hidden.coverOwner = cover?.owner
            hidden.coverBundle = bundle
            hidden.anchor = anchor.map { [Double($0.x), Double($0.y)] }
            return hidden
        }

        /// One line for the log: "window 412 of pid 355 (Setup Assistant, com.apple.SetupAssistant)
        /// layer 0 at [x, y, w, h] over the anchor [x, y]".
        public var summary: String {
            let name = [coverOwner, coverBundle].compactMap { $0 }.joined(separator: ", ")
            let bounds = coverBounds.map { "[" + $0.map { String(format: "%.0f", $0) }.joined(separator: ", ") + "]" } ?? "?"
            let at = anchor.map { "[" + $0.map { String(format: "%.0f", $0) }.joined(separator: ", ") + "]" } ?? "?"
            return "window \(coverNumber.map(String.init) ?? "?") of pid \(coverPID.map(String.init) ?? "?") (\(name.isEmpty ? "unknown owner" : name)) layer \(coverLayer.map(String.init) ?? "?") at \(bounds) over the anchor \(at)"
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
        /// How the shown alternatives are drawn at the caret: `inline` or `capsule`.
        public var caretPresentation: String?
        /// The capsule's frame, global top-left points [x, y, width, height], when they are in one.
        public var capsule: [Double]?
        /// The capsule lies `below` or `above` the caret's line.
        public var capsuleSide: String?
        public var panel: Panel?
        /// How the panel was placed around its field (`FieldPanelPlacement`).
        public var panelPlacement: PanelPlacementInfo?
        public var decor: Panel?
        public var list: Panel?
        public var figure: String?
        public var character: String?
        public var lineText: String?
        /// Headless only: the pop-up on the panel, as `SlipSpeech.popup` says it.
        public var popupSpoken: String?
        /// H8: a shown event card's destination line ("Adding to Work").
        public var eventDestination: String?
        /// Seconds the accepted work has run.
        public var working: Double?
        /// The offer key (and helper task id) of the accepted work.
        public var workingOn: String?
        /// The caret the working line is drawn at, global top-left points [x, y, width, height].
        public var workCaret: [Double]?
        /// M1: where the shown offer's first noticed fact came from ("from what Caret noticed in Mail, Tue"),
        /// and how many facts the helper named.
        public var provenance: String?
        public var provenanceFacts: Int?
        /// The tab under the slip: `shown`, `correcting`, `sending`, or the answer's sentence.
        public var notRight: String?
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
        /// The last offer withdrawn without ever being drawn (A18, bug 2).
        public var lastUnshown: Unshown?

        public init() {}
    }

    /// An offer the host never drew and withdrew: its key, kind, why it could not be drawn, and
    /// how long it waited first (0 when it could never be drawn).
    public struct Unshown: Codable, Equatable, Sendable {
        public var offerKey: String?
        public var kind: String
        public var reason: String
        public var heldMs: Int

        public init(offerKey: String?, kind: String, reason: String, heldMs: Int) {
            self.offerKey = offerKey
            self.kind = kind
            self.reason = reason
            self.heldMs = heldMs
        }
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

        enum CodingKeys: String, CodingKey { case path, error, settings, gate }

        /// The user's personal instructions go out as their lengths: the socket never carries their text (brief item 4).
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(error, forKey: .error)
            var shown = settings
            shown.instructions = settings.instructions.redacted
            try c.encode(shown, forKey: .settings)
            try c.encode(gate, forKey: .gate)
        }
    }

    /// The debug socket's `onboarding` reply (`OnboardingFlow.debugInfo`). Nothing typed or pasted appears here,
    /// only lengths (CodeRabbit #8).
    public struct OnboardingInfo: Codable, Equatable, Sendable {
        public struct HelloInfo: Codable, Equatable, Sendable {
            public var textLength: Int
            public var ghostLength: Int?
            /// `ready`, `loading` or `unavailable`.
            public var model: String
            public var apps: [String]
            public var taken: Bool
        }

        public struct AccessInfo: Codable, Equatable, Sendable {
            public var granted: Bool
            public var reopened: Bool
            public var helpOpen: Bool
        }

        /// `hello`, `access`, `on` or `first`.
        public var step: String
        /// The step's place among the steps this flow shows (`stepCount` of them).
        public var stepIndex: Int
        public var stepCount: Int?
        public var canContinue: Bool
        public var finished: Bool
        /// `main` or `guide`.
        public var frame: String?
        /// The flow is one step on its own.
        public var alone: Bool?
        public var permissions: OnboardingPermissions?
        /// Running apps that also take Tab; nil when none.
        public var otherTabOwners: [String]?
        public var hello: HelloInfo?
        public var access: AccessInfo?
        /// `idle`, `building`, `ready`, `empty` or `failed`, with the ready preview's window and character counts.
        public var preview: String?
        public var previewWindows: Int?
        public var previewChars: Int?
        /// `pending`, `sent` or `kept`.
        public var decision: String?
        /// The browser step: trusted installed browsers by name, whether the extension's page was opened, and whether
        /// the extension has connected.
        public var browsers: [String]?
        public var browserOpened: Bool?
        public var browserConnected: Bool?
        /// Other copies of Caret found, by path, and whether the switch step says the wrong one was turned on.
        public var otherCarets: [String]?
        public var wrongCaret: Bool?
        /// The entry macOS shows for Caret is on but not this build's; the step offers Reset.
        public var staleEntry: Bool?
        /// `idle`, `asking`, `found`, `nothing` or `failed`.
        public var firstLook: String?
        public var firstLookRequest: String?
        public var firstLookKind: String?
        public var firstLookTitle: String?
        public var firstLookError: String?
        /// The keys the found offer or its line take now: `tab`, `cmd-1`, `cmd-z`, `esc`.
        public var firstLookKeys: [String]?
        /// The taken offer's phase (`FirstLookRun.Phase.name`) and its line.
        public var firstLookRun: String?
        public var firstLookLine: String?
        public var declined: Bool?
        /// `asking` or `denied`: macOS's Calendar prompt around the first event taken here.
        public var calendar: String?
        /// The key field (when the cloud model needs a key): its phase, the pasted length (never the text), and
        /// whether a key is saved.
        public var jevKey: String?
        public var jevKeyLength: Int?
        public var jevKeyStored: Bool?
        /// The window is on screen. False on a run with `--onboarding hidden`.
        public var windowShown: Bool?
        /// What a flow without a window did not do (`openSystemSettings`).
        public var suppressed: [String]?

        public init(step: String, stepIndex: Int, canContinue: Bool, finished: Bool) {
            self.step = step
            self.stepIndex = stepIndex
            self.canContinue = canContinue
            self.finished = finished
        }
    }

    public struct UndoInfo: Codable, Equatable, Sendable {
        public var grantID: UInt64
        public var ok: Bool
        public var error: String?
        /// A writing fix's undo: `axRestore` or `nativeUndo` (`UndoStrategy`). Nil for other grants.
        public var strategy: String?

        public init(grantID: UInt64, ok: Bool, error: String?, strategy: String? = nil) {
            self.grantID = grantID
            self.ok = ok
            self.error = error
            self.strategy = strategy
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
        /// Plain Tabs decided, and those that went on to the app because Caret held no offer for it.
        /// Tabs another app's tap took before Caret's never arrive, so neither counts them.
        public var tabs: UInt64?
        public var tabsPassed: UInt64?
        /// Keys the debug socket's `key` hook routed. They count in `keyDowns` and `consumed` as
        /// well, since they take offers through the same path as the tap's.
        public var hookKeys: UInt64?

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
    /// The last ghost text held because another window covered the caret: which window (H7b: V1b's
    /// check 7 held five Tab offers as covered and nothing said by what).
    public var ghostHold: LineHidden?
    /// Running apps that also take Tab for their own completions (`OtherTabOwners`). Q1 (A18): with
    /// Cotypist running, its Tab took one word per press while Caret's counters stayed at zero.
    public var otherTabOwners: [String]?
    /// The writing checks in the focused field: marks, and the panels drawn for them.
    public var writing: WritingInfo?
    /// "Caret can't see this page yet" (`PageSight`): the browser it shows for, the browsers asked
    /// about this session, and those the helper says it cannot see.
    public var pageSight: PageSight.DebugInfo?

    /// H6: the host following the helper's router (`RouteFollower`). Ids and counts, never text.
    public var routing: RoutingInfo?
    /// H8: Calendar access and where the next accepted event goes. Ids and the calendar's title only.
    public var calendar: CalendarInfo?
    /// H8: the helper's model spend since it started, as it last sent it.
    public var spend: HelperSpend?
    /// H13: inline text in page fields. States, lengths and timings only: never the page's text nor the suggestion.
    public var pageInline: PageInlineInfo?
    /// H14: the page task panel (`PageTaskMachine.Status`), the attach row whose open panel is up, and the panel on screen.
    public var pageTask: PageTaskInfo?
    /// H14: the line offering to keep a file, and its panel.
    public var fileSave: FileSaveInfo?

    public struct PageTaskInfo: Codable, Equatable, Sendable {
        public var status: PageTaskMachine.Status
        public var choosing: Int?
        public var filesWired: Bool
        public var panel: Panel?
        /// The last acceptance Tab sent: its goal and segment, and the confirmed file's step and name (never its folder).
        public var lastAccept: String?
        public var lastAcceptFileStep: Int?
        public var lastAcceptFileName: String?
        public init(status: PageTaskMachine.Status, choosing: Int?, filesWired: Bool, panel: Panel?, lastAccept: GoalAccept? = nil) {
            self.status = status; self.choosing = choosing; self.filesWired = filesWired; self.panel = panel
            self.lastAccept = lastAccept.map { "\($0.goalId):\($0.segment)" }
            lastAcceptFileStep = lastAccept?.confirmedFile?.step
            lastAcceptFileName = lastAccept?.confirmedFile.map { ($0.path as NSString).lastPathComponent }
        }
    }

    public struct FileSaveInfo: Codable, Equatable, Sendable {
        public var phase: String
        public var panel: Panel?
        public init(phase: String, panel: Panel?) {
            self.phase = phase; self.panel = panel
        }
    }

    public struct PageInlineInfo: Codable, Equatable, Sendable {
        /// The machine's last decision (`shown`, `midLine`, `ownSuggestions`, `insert.inserted`...).
        public var last: String?
        /// Inline text is on screen now, and how many characters it has.
        public var shownLength: Int?
        /// The quiet line about a page's own suggestions is on screen.
        public var notice: Bool
        /// The page field the user is in: its role and the length of the text around its caret. No text.
        public var fieldRole: String?
        public var beforeLength: Int?
        public var afterLength: Int?
        public var ownSuggestions: String?
        /// The page's Tab owner the arbiter yields to now (`OtherTabOwners.pages`).
        public var tabOwner: String?
        /// Keystroke (seen by the tap) to inline text drawn in a page field.
        public var latency: LatencyRecorder.Summary
        /// The engine's generation alone, for the same suggestions.
        public var generation: LatencyRecorder.Summary

        public init(last: String?, shownLength: Int?, notice: Bool, fieldRole: String?, beforeLength: Int?, afterLength: Int?, ownSuggestions: String?,
                    tabOwner: String?, latency: LatencyRecorder.Summary, generation: LatencyRecorder.Summary) {
            self.last = last; self.shownLength = shownLength; self.notice = notice; self.fieldRole = fieldRole
            self.beforeLength = beforeLength; self.afterLength = afterLength; self.ownSuggestions = ownSuggestions
            self.tabOwner = tabOwner; self.latency = latency; self.generation = generation
        }
    }

    public struct CalendarInfo: Codable, Equatable, Sendable {
        /// `CalendarAccess` by name.
        public var access: String
        /// The event card's line ("Adding to Work").
        public var line: String
        /// The calendar's EventKit identifier, once access lets it be read.
        public var calendarId: String?
        /// The user picked it; false for the default.
        public var chosen: Bool

        public init(_ d: EventDestination, access: CalendarAccess) {
            self.access = access.rawValue
            line = EventCalendarCopy.cardLine(d)
            calendarId = d.calendar?.id
            if case .calendar(_, let chosen, _) = d { self.chosen = chosen } else { chosen = false }
        }
    }
    /// Keystroke to ghost-text paint for the key that finished a sentence or paragraph, the
    /// breakpoint the router decides at; `latency` holds every key's.
    public var breakpointLatency: LatencyRecorder.Summary?

    public struct RoutingInfo: Codable, Equatable, Sendable {
        /// The user's "Caret decides when to help".
        public var enabled: Bool
        /// The helper is connected and took routing in this connection's hello.
        public var linked: Bool
        /// No decision came within the budget on this connection, and none applied since.
        public var unavailable: Bool
        /// What ambient help may do now: `allow:<why>`, `wait`, or `quiet:<outcome>`.
        public var gate: String
        /// `deciding`, or the decision's outcome, and its route for `act`.
        public var phase: String?
        public var route: String?
        /// Why the router failed, while an `error` decision holds (R2).
        public var failure: String?
        /// The helper's ids for the focused field, once a decision named it.
        public var windowId: String?
        public var key: String?
        public var budgetMs: Int64
        public var stats: RouteFollower.Stats
        /// Breakpoint or focus to the decision that settled it, as the host saw it.
        public var entry: LatencyRecorder.Summary

        public init(enabled: Bool, linked: Bool, unavailable: Bool, gate: String, phase: String?, route: String?, failure: String? = nil,
                    windowId: String?, key: String?, budgetMs: Int64, stats: RouteFollower.Stats, entry: LatencyRecorder.Summary) {
            self.enabled = enabled; self.linked = linked; self.unavailable = unavailable; self.gate = gate; self.phase = phase; self.route = route
            self.failure = failure; self.windowId = windowId; self.key = key; self.budgetMs = budgetMs; self.stats = stats; self.entry = entry
        }
    }

    /// What `WritingCoordinator` holds and draws. Spans and frames, never the field's text.
    public struct WritingInfo: Codable, Equatable, Sendable {
        /// Checks run at a sentence boundary, and how the last one went.
        public var checks: Int = 0
        /// `checked`, `noLanguage` (static rules only), `stale`, `skippedCode`, `skippedComposing`.
        public var lastCheck: String?
        public var marks: [Mark] = []
        /// Underline panels on screen, one per mark that had bounds.
        public var underlines: [Panel] = []
        /// The correction line, the open list or the toast.
        public var panel: Panel?
        /// `line`, `expanded`, `toast` or `error`.
        public var panelRole: String?
        /// The line is placed from the active mark's text bounds (`bounds`) or, with none, under
        /// the caret (`caret`).
        public var anchoredBy: String?

        public struct Mark: Codable, Equatable, Sendable {
            public var start: Int
            public var end: Int
            public var kind: String
            public var declined: Bool
            public var needsChoice: Bool
            /// `AXBoundsForRange` gave a usable rect on one line.
            public var hasBounds: Bool

            public init(start: Int, end: Int, kind: String, declined: Bool, needsChoice: Bool, hasBounds: Bool) {
                self.start = start
                self.end = end
                self.kind = kind
                self.declined = declined
                self.needsChoice = needsChoice
                self.hasBounds = hasBounds
            }
        }

        public init() {}
    }

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
