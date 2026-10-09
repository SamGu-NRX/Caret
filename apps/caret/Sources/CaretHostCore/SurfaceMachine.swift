import CaretScreenCore
import CoreGraphics
import Foundation

/// The decisions behind the offers that are not the engine's ghost text or a fill: alternatives at
/// the caret, action lines and pop-ups, and the working, result and error lines and the toast that
/// follow an accepted action (`SURFACES.md` sections 2 to 4 and 6).
///
/// It decides when an offer is drawn or held, retries a held one, withdraws a shown one when its
/// app goes behind or the helper takes it back, turns a claim into work and its line, and owns the
/// toast's undo. The system comes in through `SurfaceWorld` as plain values; what to draw, hide and
/// send goes out as `SurfaceCommand` and `SurfaceSend`. Time comes from a `SurfaceClock`. Same
/// invariant as the other coordinators: what is on screen is exactly what the arbiter holds. The
/// arbiter decides every key; this decides what the keys' results look like.
///
/// `headless` (`--surfaces headless`) is for socket-level tests while someone is using the Mac:
/// helper offers are bound to the field the helper names instead of the one Accessibility reports,
/// keys come from the debug socket's `key` hook as usual, and no panel command is issued.
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class SurfaceMachine {
    public struct Shown: Equatable, Sendable {
        public let offerID: UInt64
        public let offer: Offer
        /// The helper's key for the offer. Nil for injected alternatives, which have none.
        public let offerKey: String?
        /// The field's caret, global top-left points, where panels are anchored.
        public let caret: CGRect
        /// The field's frame, global top-left points.
        public let field: CGRect
        public let quoted: Bool
        /// The field read it was drawn from; nil on a headless host, which reads nothing.
        public let readID: UInt64?
        /// How alternatives are drawn at the caret; inline for every other kind.
        public var presentation: CaretPresentation = .inline
        /// The alternatives' capsule as last drawn, global top-left points.
        public var capsule: CGRect?
    }

    /// What was last taken, for the debug state.
    public struct Accepted: Codable, Equatable, Sendable {
        public var offerKey: String?
        public var actionId: String?
        public var candidate: Int?
        public var row: Int?
        public var overrides: [String: Int]?
        public var source: String
        public var kind: String
    }

    struct Pending {
        let incoming: SurfaceIncoming
        let since: Date
        let hold: SurfaceGate.Hold
    }

    struct FillWork: Equatable {
        let rows: Int
        let source: String?
    }

    struct Work {
        let offerKey: String
        let app: String
        let pid: Int32
        let statusID: UInt64
        let startedAt: Date
        let source: OfferSource
        /// The field the offer was taken in: a fill's undo grant is bound to it.
        let target: TargetIdentity
        /// A fill pop-up: the fields its Tab writes and where the values came from.
        let fill: FillWork?
        /// Steps the helper verified so far: the fill toast's count when `done` carries none.
        var verified = 0
        /// The fields the run wrote, from its `done` progress (`TaskProgress.written`).
        var written: Int?
        /// The plan's step count and the first step not yet done, from the run's progress, so a
        /// stop can say where it stopped.
        var steps: Int?
        var nextStep: Int?
        /// The figure has looked away and left the working line.
        var figureLeft = false
        /// A skill started it with no Tab (B19 `taskProgress.unprompted`); `name` is the skill's.
        var unprompted = false
        /// The helper's event card (H8): its run adds an event, which the task's ledger removes by id.
        var eventCard = false
        var name: String?
        /// The field and caret the line was first drawn at, global top-left points: a result that
        /// grows (a question under it) is placed again around them.
        var anchor: Anchor?
    }

    struct Anchor {
        let field: CGRect
        let caret: CGRect
    }

    /// The run whose result or toast is on the panel, and the line it shows: what a skill question
    /// attaches to.
    struct Result {
        let taskID: String
        let target: TargetIdentity
        let anchor: Anchor?
        var line: WorkLine
    }

    /// A keep or promote question under `result` (B19 `skillOffer`), the arbiter offer that holds its
    /// Tab and Esc, and the row as drawn: the question, or what Tab did.
    struct Question {
        enum State: Equatable {
            /// On screen with its keys.
            case asked
            /// Tab said yes; waiting for the helper's withdrawal that says it took it.
            case pending
            /// The row reports how it ended.
            case settled
        }
        let offer: SkillOffer
        let offerID: UInt64
        var row: LineContent.Question
        var state = State.asked
        var answered: Bool { state != .asked }
    }

    /// What a visibility watch protects, and what losing it does.
    enum Watched: Equatable {
        /// The shown offer: withdrawn.
        case offer(UInt64)
        /// The working or result line: taken down, and it gives up its keys.
        case line
    }

    struct Watch {
        let watched: Watched
        let target: TargetIdentity
        let anchors: [CGPoint]
        let requireFocus: Bool
        /// The field the surface was drawn for: the frame a writing aid's ring is measured against
        /// when the app's focused frame cannot be read at a recheck.
        let field: CGRect?
        let timer: SurfaceTimer
    }

    /// A line withdrawn as `reoffered`, waiting for the offer that replaces it.
    struct Swap {
        let newKey: String
        let timer: SurfaceTimer
    }

    /// How long a reoffered line waits for its replacement before it goes. Assumed, not measured:
    /// the helper sends the new offer in the same turn as the withdrawal (engine.ts), so it should
    /// arrive within milliseconds; a second covers a busy main thread.
    public static let swapWait: TimeInterval = 1

    /// Half a second, assumed: fast enough that a surface over someone else's window does not
    /// linger, and a window-list read costs about a millisecond.
    public static let recheckInterval: TimeInterval = 0.5
    /// How long after macOS answers its Calendar prompt the line's watch waits for the user's app to be in
    /// front again. Assumed, not measured: activation came back within a second in the VM's runs.
    public static let calendarFrontGrace: TimeInterval = 1.5
    /// How long a held offer is retried before it is dropped. Assumed, not measured.
    public static let holdLimit: TimeInterval = 30
    /// How long the line Esc left waits for the helper's own ending before it goes anyway (no
    /// helper, or one that never answers). The helper stops at its next step boundary, so a slow
    /// step can take seconds (A15: the A12 harness holds a step for 5 s). The same cap as the
    /// "Undoing" line's; assumed, not measured.
    public static let stopConfirmWait: TimeInterval = 10
    /// How long the stopped line stays once its ending is known.
    public static let stoppedLineLifetime: TimeInterval = 3
    /// How long the line saying a stop could not be confirmed stays: a longer sentence that asks
    /// the user to act. Assumed, not measured.
    public static let stopUnreachedLifetime: TimeInterval = 8
    /// How long a keep or promote question stays under its run's line. Assumed, not measured: two
    /// short lines and one decision. The helper keeps the offer two minutes (lifetimes.ts `skill`)
    /// and may ask again after a later run, so letting it go unanswered costs nothing.
    public static let questionLifetime: TimeInterval = 15
    /// How long the answer to a question stays before the line leaves. Assumed.
    public static let answerHold: TimeInterval = 2
    /// How long an answer that did not go through stays: as long as other errors (`SURFACES.md` 6),
    /// since it says what to check.
    public static let answerFailHold: TimeInterval = 6
    /// How long a yes waits for the helper to confirm it (`offerWithdrawn` taken) before the row
    /// says it was not confirmed. Assumed: the helper answers in the same turn it reads the line.
    public static let answerWait: TimeInterval = 2
    /// How long ⌘Z belongs to the done line of a run nobody asked for. Assumed: longer than a Tab'd
    /// run's 5 s (`UndoGrant.defaultLifetime`), since the user did not start it and may look up
    /// late; the activity list keeps its Undo after that.
    public static let unpromptedToastLifetime: TimeInterval = 8

    let arbiter: OfferArbiter
    let world: SurfaceWorld
    let clock: SurfaceClock
    public let headless: Bool
    /// Where commands go. Set once, before offers flow.
    public var output: (SurfaceCommand) -> Void = { _ in }
    /// Sends to the helper; true when written. Set once, before offers flow.
    public var sendToHelper: (SurfaceSend) -> Bool = { _ in false }
    /// H8: Caret has never asked for Calendar access (`CalendarAccess.notDetermined`), so accepting an
    /// event card asks first. Read at each accept. Set once, before offers flow.
    public var calendarAccessUndetermined: () -> Bool = { false }

    public internal(set) var shown: Shown?
    /// The offer a newer one replaced on the panel, kept until the next replacement: a Tab the tap
    /// took on it may reach main after the newer offer was drawn (`claimed`).
    var displacedShown: Shown?
    /// H8: an accepted event card's `offerAccept`, waiting for macOS to answer the Calendar prompt
    /// (`askCalendarAccess`). Sent once it answers; `endWork` drops it, so it never outlives its work.
    var calendarHeld: OfferAccept?
    /// Which scheduled line watch is current: each work started, and each answer, makes a new one, so a
    /// late watch never lands on later work that reused the offer key (a new helper counts from 1 again).
    var calendarWatchToken = 0
    /// An event card's done line that holds ⌘Z: its task and app, so the undo's answer is said as an event's.
    var eventUndo: (task: String, app: String)?
    /// An offer held by `SurfaceGate`, retried until it may be drawn, it is withdrawn, or 30 s pass.
    var pending: Pending?
    var pendingTimer: SurfaceTimer?
    var watch: Watch?
    var work: Work?
    /// The work Esc stopped, kept while its "Stopping…" line waits for the helper's own ending,
    /// which says where it stopped (or that it finished first).
    var stoppedWork: Work?
    /// Each delivered stop's deadline, by task, independent of any line: a stop no ending answers
    /// within `stopConfirmWait` closes the helper session even if its line was dismissed or replaced
    /// (A17 review). Cleared by the task's ending, or when the connection closes.
    var stopDeadlines: [String: SurfaceTimer] = [:]
    var result: Result?
    var question: Question?
    /// Questions asked, by their arbiter offer id, until answered or 2 lifetimes old: a Tab or Esc the
    /// tap took on one is answered even if main took its line down before the key's callback ran.
    var asked: [UInt64: (offer: SkillOffer, at: Date)] = [:]
    var questionTimer: SurfaceTimer?
    /// Runs with no Tab already drawn once: a later progress of one never takes the panel back.
    var unpromptedDrawn: Set<String> = []
    /// Runs a skill started with no Tab, seen in progress and not drawn yet: each is drawn once its
    /// activity record names the app and the skill (`activity`), or never.
    var unpromptedSeen: Set<String> = []
    /// Recent activity records by task id, for those runs.
    var records: [String: TaskRecord] = [:]
    var swap: Swap?
    /// What the last `covered` answer found over the anchor.
    var lastCovered: DebugState.LineHidden?
    /// Set by `present` when it redrew a re-sent offer in place; read by `receive`.
    var replacedInPlace = false
    var workTimers: [SurfaceTimer] = []
    var resultTimer: SurfaceTimer?
    var resultStatusID: UInt64?
    /// The fill toast's undo grant while ⌘Z can still take it.
    public internal(set) var toastGrantID: UInt64?
    /// The task ⌘Z asked the helper to undo; its `undone` progress gets the last word.
    var undoing: String?
    public internal(set) var toastInfo: DebugState.Toast?
    /// The working or result line was taken down because its app went behind or was covered; it
    /// stays down until the next offer.
    public internal(set) var lineSuppressed = false
    /// Why the working or result line was last taken down by its watch, and what covered it.
    public internal(set) var lastLineHidden: DebugState.LineHidden?
    public internal(set) var lastAccepted: Accepted?
    /// What the panel says, and its figure. Kept on a headless host too, for the debug state.
    public internal(set) var lineText: String?
    public internal(set) var figure: FigureState?
    /// The panel was last told to show, not to hide.
    public internal(set) var panelUp = false
    /// When the panel's last exit finishes. Until then a hide still goes out: an immediate one
    /// cuts a running fade short, so an old line does not fade over a new offer.
    var panelExitEnds: Date?
    /// M1: where the noticed facts behind recent offers came from, by offer key, newest last; the
    /// helper sends each right after its offer (`provenance`).
    var provenances: [(key: String, value: MemoryProvenance)] = []

    public init(arbiter: OfferArbiter, world: SurfaceWorld, clock: SurfaceClock, headless: Bool) {
        self.arbiter = arbiter
        self.world = world
        self.clock = clock
        self.headless = headless
    }

    func emit(_ command: SurfaceCommand) { output(command) }
    func count(_ name: String) { output(.count(name)) }
    func publish() { output(.publish) }
    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    // MARK: - Offers in

    /// An offer from the helper: shown in its field if that field is where the user is looking,
    /// otherwise held and retried. The field is matched by frame and by the window the reader
    /// names for it (`FieldMatch`).
    @discardableResult
    public func receive(_ offer: HelperOffer) -> String {
        count("surface.helper.\(offer.kindName)")
        let before = shown
        replacedInPlace = false
        let reply = present(.helper(offer, window: offer.window))
        // Sent again under the shown key but held or refused: what is on screen under that key is
        // what the helper no longer offers (a candidate whose source closed), so it goes.
        if let before, before.offer.source == .helper, before.offerKey == offer.offerKey, !replacedInPlace,
           let shown, shown.offerID == before.offerID {
            arbiter.invalidate(offerID: shown.offerID)
            clear(exit: 0.10)
            count("surface.withdrawn.resentNotShown")
            publish()
        }
        return reply
    }

    /// The helper withdrew a loopFinish or routine as `reoffered` and sends its rest at once under
    /// `replacedBy`. Keys no longer take the old line, but it stays up so the new one is drawn over
    /// it in place rather than leaving and entering (`swapWait`).
    func reoffered(_ key: String, replacedBy newKey: String) {
        count("surface.withdrawn.helper.reoffered")
        if displacedShown?.offerKey == key { displacedShown = nil }
        if pending?.incoming.helperKey == key { cancelPending() }
        guard let shown, shown.offer.source == .helper, shown.offerKey == key else { return publish() }
        arbiter.invalidate(offerID: shown.offerID)
        stopWatch()
        if !headless { emit(.clearCaret(offerID: shown.offerID)) }
        self.shown = nil
        endSwap(takeDown: false)
        let timer = clock.schedule(after: Self.swapWait, repeats: false) { [weak self] in
            guard let self, self.swap?.newKey == newKey else { return }
            self.count("surface.reoffer.notReplaced")
            self.endSwap(takeDown: true)
            self.publish()
        }
        swap = Swap(newKey: newKey, timer: timer)
        publish()
    }

    /// Ends a swap. `takeDown`: its replacement will not be drawn, so the old line goes now.
    func endSwap(takeDown: Bool, exit: TimeInterval = 0.10) {
        guard let swap else { return }
        swap.timer.cancel()
        self.swap = nil
        if takeDown, shown == nil, work == nil, resultTimer == nil { takeLineDown(exit: exit) }
    }

    /// The helper's connection dropped. Nothing it offered can be taken now (`offerAccept` would
    /// go nowhere) and it will withdraw nothing, so its shown and held offers go. A run it was
    /// doing will send no `taskProgress`, so its working line ends now; the activity list starts
    /// again with the next helper.
    public func helperGone() {
        calendarWatchToken &+= 1
        // An answer can no longer reach the helper, and a new one will ask again.
        dropQuestion("surface.skill.helperGone")
        asked.removeAll()
        // The connection closed, which makes the helper revoke this session's work (B22): no stop is
        // waiting on it any more. One still on screen gets no answer: say it is not known to have stopped.
        for timer in stopDeadlines.values { timer.cancel() }
        stopDeadlines.removeAll()
        if work == nil, stoppedWork != nil {
            count("surface.stop.helperGone")
            stopUnconfirmed()
        }
        if let work, work.source == .helper {
            count("surface.work.helperGone")
            end(with: .helperDown)
        }
        if pending?.incoming.helperKey != nil { cancelPending() }
        endSwap(takeDown: true)
        if let displaced = displacedShown, displaced.offer.source == .helper { displacedShown = nil }
        guard let shown, shown.offer.source == .helper else { return publish() }
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0.10)
        count("surface.withdrawn.helperGone")
        publish()
    }

    /// The helper withdrew an offer: take it down if it is shown, forget it if it is held, or swap
    /// it for its replacement if it was `reoffered`. Work already accepted from it goes on.
    public func withdrawn(_ message: OfferWithdrawn) {
        asked = asked.filter { $0.value.offer.id != message.id || $0.key == question?.offerID }
        if var q = question, q.offer.id == message.id {
            switch q.state {
            case .asked:
                arbiter.invalidate(offerID: q.offerID)
                asked[q.offerID] = nil
                question = nil
                count("surface.skill.withdrawn.\(message.reason.rawValue)")
                redrawResult()
            case .pending:
                // The helper's answer to Tab: taken is done; anything else means it did not apply it.
                q.state = .settled
                q.row = message.reason == .taken ? WorkLines.answered(q.offer) : WorkLines.answerNotTaken
                question = q
                count(message.reason == .taken ? "surface.skill.confirmed" : "surface.skill.notTaken")
                questionTimer?.cancel()
                questionTimer = nil
                if let result { showResult(result.line, lifetime: message.reason == .taken ? Self.answerHold : Self.answerFailHold) }
            case .settled:
                break
            }
            return publish()
        }
        // CaretScreenCore's decoder refuses `reoffered` without `replacedBy`, so a line off the
        // wire always takes the swap; one built in code without it is an ordinary withdrawal.
        if message.reason == .reoffered, let newKey = message.replacedBy { return reoffered(message.id, replacedBy: newKey) }
        let shownKey = shown.flatMap { $0.offer.source == .helper ? $0.offerKey : nil }
        let effect = OfferLifecycle.withdrawal(of: message.id, shownKey: shownKey, heldKey: pending?.incoming.helperKey)
        if effect.removeShown, let shown {
            arbiter.invalidate(offerID: shown.offerID)
            clear(exit: 0.10)
            count("surface.withdrawn.helper.\(message.reason.rawValue)")
        }
        if effect.dropHeld { cancelPending() }
        // The replacement of a reoffered line was withdrawn before it was drawn.
        if swap?.newKey == message.id { endSwap(takeDown: true) }
        // A late Tab on a replaced offer the helper has since withdrawn is not honored.
        if displacedShown?.offerKey == message.id { displacedShown = nil }
        publish()
    }

    /// Shows an injected offer for the focused field of its pid. Returns a JSON reply.
    @discardableResult
    public func inject(_ injection: SurfaceInjection) -> String {
        if case .helperLine = injection { return #"{"error":"helperLine is handled by the runtime"}"# }
        return present(.injected(injection))
    }

    func present(_ incoming: SurfaceIncoming) -> String {
        // A headless host reads and writes nothing, so its pids need not be live processes: socket
        // runs use the recordings' synthetic pids. `world.allows` knows which check applies.
        guard let pid = incoming.pid, world.allows(pid: pid) else {
            count("surface.refused.pidNotAllowed")
            return #"{"error":"pid not allowed"}"#
        }
        if headless {
            guard case .helper(let helperOffer, _) = incoming else { return #"{"error":"a headless host draws no injected offer"}"# }
            return presentHeadless(helperOffer)
        }
        // Gate first, before any Accessibility read of a background app (SurfaceGate).
        guard world.frontmostPID == pid else { return hold(incoming, .appNotFront) }
        guard let field = world.focusedField(pid: pid) else { return hold(incoming, .fieldNotFocused) }
        // A helper offer is for one field, named by its frame and window; any other focused field waits.
        guard incoming.isFor(field) else { return hold(incoming, .fieldNotFocused) }
        let caret: CGRect
        switch world.caret(of: field) {
        case .noSnapshot: return #"{"error":"no snapshot of the field"}"#
        case .noCaret: return #"{"error":"no caret"}"#
        case .at(let rect): caret = rect
        }
        let anchors = [CGPoint(x: caret.midX, y: caret.midY)]
        if let held = gate(field.identity, anchors: anchors, requireFocus: true) { return hold(incoming, held) }
        let presentation = Self.presentation(incoming.candidates, field: field, caret: caret, width: { self.world.textWidth($0, readID: field.readID) })
        guard let offer = incoming.offer(for: field, createdAt: clock.now) else { return #"{"error":"nothing to show"}"# }
        if let reply = replaceInPlace(incoming, with: offer, caret: caret, field: field.frame ?? caret, readID: field.readID, presentation: presentation) {
            guard let shown else { return Self.notDrawnReply }
            startWatch(.offer(shown.offerID), target: field.identity, anchors: Self.watchAnchors(shown), requireFocus: true, field: field.frame)
            return reply
        }
        // An action line or pop-up needs a spot that covers none of the app's fields or labels: its
        // full panel, else its compact line, else it is not drawn at all (brief A13, part 3). Only
        // the user's ↓ opens the full card from there, wherever it covers least (OfferArbiter, A14).
        var compact = false
        if let full = Self.panelContent(for: offer) {
            let frame = field.frame ?? caret
            if !world.panelIsClear(full, field: frame, caret: caret, pid: pid) {
                guard let small = Self.compactContent(for: offer, ui: OfferUI(initialFor: offer)),
                      world.panelIsClear(small, field: frame, caret: caret, pid: pid) else {
                    // Only the screen around the field could change the answer, and probing it again
                    // every half second costs main-thread hit-tests; the helper offers again on
                    // change. Never drawn, so withdrawn and logged rather than kept (A18, bug 2).
                    return unshown(incoming, .noClearSpot, since: clock.now)
                }
                compact = true
                count("surface.compact.\(offer.kind.name)")
            }
        }
        let swapping = incoming.helperKey != nil && swap?.newKey == incoming.helperKey
        cancelPending()
        // Another offer takes the panel from a reoffered line as from any line: at once.
        endSwap(takeDown: !swapping, exit: 0)
        makeRoom(for: offer)
        // Alternatives can fail to draw, so they own no key until they are on screen (`reveal`).
        let drawnLater = offer.kind == .ghost
        guard let offerID = arbiter.publish(offer, compact: compact, shown: !drawnLater) else {
            if swapping { takeLineDown(exit: 0.10) }
            return #"{"error":"arbiter refused (an insertion is running)"}"#
        }
        let stamped = arbiter.snapshot().current.flatMap { $0.id == offerID ? $0 : nil } ?? offer
        shown = Shown(
            offerID: offerID, offer: stamped, offerKey: incoming.offerKey, caret: caret, field: field.frame ?? caret,
            quoted: incoming.quoted, readID: field.readID, presentation: presentation
        )
        // A reoffered line's replacement is drawn over it where it stands, without an exit and entry.
        draw(ui: arbiter.snapshot().ui, entering: !swapping)
        // The renderer could not draw alternatives where the user can see them: already withdrawn.
        guard let drawn = shown, drawn.offerID == offerID else { return Self.notDrawnReply }
        if drawnLater, !arbiter.reveal(offerID: offerID) {
            // A key reached the app between the publish and the draw and dismissed it.
            clear(exit: 0)
            count("surface.dismissedBeforeDrawn")
            return #"{"error":"a key dismissed it before it was drawn"}"#
        }
        if swapping { count("surface.reoffer.swapped") }
        startWatch(.offer(offerID), target: field.identity, anchors: Self.watchAnchors(drawn), requireFocus: true, field: field.frame)
        count("surface.shown.\(offer.source.rawValue).\(offer.kind.name)")
        if case .ghost = offer.kind {
            count("surface.caret.\(presentation.rawValue)")
            return #"{"ok":true,"offerId":\#(offerID),"presentation":"\#(presentation.rawValue)"}"#
        }
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

    /// Inline when the widest candidate fits after the caret inside the field with nothing after
    /// the caret (`SurfaceGate.fitsInField`); otherwise a capsule off the caret's line. This only
    /// chooses how alternatives are drawn: before V1a check 4 an offer that did not fit inline was
    /// withdrawn, and in a document that filled its window that was most of them.
    ///
    /// The caret's own height, not 3 pt more for the underline: in a single-line field that holds
    /// text, KeyType estimates the caret flush with the field's bottom edge
    /// (AXCaretGeometryResolver, single-line branch), and A10's filled-field run would otherwise
    /// put every alternative in a capsule.
    static func presentation(_ candidates: [String], field: FocusedField, caret: CGRect, width: (String) -> CGFloat) -> CaretPresentation {
        guard !candidates.isEmpty, let frame = field.frame else { return .inline }
        let widest = candidates.map(width).max() ?? 0
        let ghostRect = CGRect(x: caret.maxX, y: caret.minY, width: widest, height: caret.height)
        let textAfter = field.selection.end < UTF16Text.length(field.value)
        return SurfaceGate.fitsInField(ghost: ghostRect, field: frame, textAfterCaret: textAfter) ? .inline : .capsule
    }

    /// The caret, and the corners of the alternatives' capsule when they are in one: a window that
    /// comes over either takes the offer down (real ghost capsules are watched the same way).
    static func watchAnchors(_ shown: Shown) -> [CGPoint] {
        var anchors = [CGPoint(x: shown.caret.midX, y: shown.caret.midY)]
        if let c = shown.capsule {
            anchors += [CGPoint(x: c.minX + 1, y: c.minY + 1), CGPoint(x: c.maxX - 1, y: c.minY + 1),
                        CGPoint(x: c.minX + 1, y: c.maxY - 1), CGPoint(x: c.maxX - 1, y: c.maxY - 1)]
        }
        return anchors
    }

    /// The reply to an offer the renderer did not draw, already withdrawn and logged (`withdrawUndrawn`).
    static let notDrawnReply = #"{"held":"notDrawn","unshown":true}"#

    /// The headless path: the offer is bound to the field the helper names and published, and
    /// nothing is read or drawn.
    func presentHeadless(_ helperOffer: HelperOffer) -> String {
        let offer = helperOffer.offer(target: helperOffer.declaredTarget, fieldValue: "", caretUTF16: 0, createdAt: clock.now)
        let declared = helperOffer.field.frame.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) } ?? .zero
        if let reply = replaceInPlace(.helper(helperOffer, window: helperOffer.window), with: offer, caret: declared, field: declared, readID: nil) {
            return reply
        }
        let swapping = swap?.newKey == helperOffer.offerKey
        cancelPending()
        // Another offer takes the panel from a reoffered line as from any line: at once.
        endSwap(takeDown: !swapping, exit: 0)
        makeRoom(for: offer)
        guard let offerID = arbiter.publish(offer) else {
            if swapping { takeLineDown(exit: 0.10) }
            return #"{"error":"arbiter refused (an insertion is running)"}"#
        }
        let stamped = arbiter.snapshot().current.flatMap { $0.id == offerID ? $0 : nil } ?? offer
        shown = Shown(
            offerID: offerID, offer: stamped, offerKey: helperOffer.offerKey, caret: declared, field: declared,
            quoted: helperOffer.quoted, readID: nil
        )
        draw(ui: arbiter.snapshot().ui, entering: !swapping)
        if swapping { count("surface.reoffer.swapped") }
        count("surface.shown.headless.\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

    /// Alternatives the helper sent again under the key already shown: fewer candidates, or a
    /// changed spelling or ref. The ghost text is redrawn where it stands, with no exit and entry,
    /// and the user keeps their place in the list (`OfferArbiter.replace`). Nil when it cannot be
    /// replaced in place; the caller shows it as a new offer.
    func replaceInPlace(_ incoming: SurfaceIncoming, with offer: Offer, caret: CGRect, field: CGRect, readID: UInt64?,
                        presentation: CaretPresentation = .inline) -> String? {
        guard let shown, shown.offer.source == .helper, let key = incoming.helperKey, shown.offerKey == key,
              case .ghost = offer.kind, case .ghost = shown.offer.kind,
              let ui = arbiter.replace(offerID: shown.offerID, with: offer) else { return nil }
        cancelPending()
        let stamped = arbiter.snapshot().current.flatMap { $0.id == shown.offerID ? $0 : nil } ?? offer
        self.shown = Shown(
            offerID: shown.offerID, offer: stamped, offerKey: key, caret: caret, field: field,
            quoted: incoming.quoted, readID: readID ?? shown.readID, presentation: headless ? .inline : presentation
        )
        replacedInPlace = true
        draw(ui: ui, entering: false)
        count("surface.replaced.helper.ghost")
        return #"{"ok":true,"offerId":\#(shown.offerID),"replaced":true}"#
    }

    /// A new offer takes the one panel: whatever offer, work line, result or toast was on it ends.
    /// Work goes on unseen and its progress is ignored; the activity list still reports it.
    func makeRoom(for offer: Offer) {
        displacedShown = shown
        clear(exit: 0)
        endWork()
        endResult()
        // Alternatives draw at the caret, not on the panel, so a line left there goes now.
        if case .ghost = offer.kind { takeLineDown(exit: 0) }
    }

    /// Nothing is drawn; the offer waits, and is tried again every half second for 30 s, then
    /// withdrawn (`unshown`). An offer only the field's own content could ever let through goes to
    /// `unshown` at once instead.
    func hold(_ incoming: SurfaceIncoming, _ reason: SurfaceGate.Hold) -> String {
        count("surface.held.\(reason.rawValue)")
        // A reoffered line whose replacement cannot be drawn now goes, rather than sit with no key.
        if let key = incoming.helperKey, swap?.newKey == key { endSwap(takeDown: true) }
        // The same offer keeps its first hold time; a different one starts over.
        let since = pending.flatMap { $0.incoming.offerKey == incoming.offerKey ? $0.since : nil } ?? clock.now
        pending = Pending(incoming: incoming, since: since, hold: reason)
        if pendingTimer == nil {
            pendingTimer = clock.schedule(after: Self.recheckInterval, repeats: true) { [weak self] in self?.retryPending() }
        }
        publish()
        return #"{"held":"\#(reason.rawValue)"}"#
    }

    func retryPending() {
        guard let pending else { return cancelPending() }
        if clock.now.timeIntervalSince(pending.since) > Self.holdLimit {
            _ = unshown(pending.incoming, pending.hold, since: pending.since)
            return
        }
        _ = present(pending.incoming)
    }

    /// The last offer withdrawn without being drawn, for the debug state.
    public internal(set) var lastUnshown: DebugState.Unshown?

    /// An offer that was never drawn is withdrawn, counted and logged, never kept waiting: one
    /// that can never be drawn (no clear spot) at once, one held for `holdLimit` when that ends
    /// (A18, bug 2). A held offer owns no key, so Tab and the arrows stay the app's throughout.
    /// The helper is not told: the protocol has no host-to-helper message for an offer not shown.
    func unshown(_ incoming: SurfaceIncoming, _ reason: SurfaceGate.Hold, since: Date) -> String {
        count("surface.held.\(reason.rawValue)")
        count("surface.unshown.\(reason.rawValue)")
        if let key = incoming.helperKey, swap?.newKey == key { endSwap(takeDown: true) }
        pendingTimer?.cancel()
        pendingTimer = nil
        pending = nil
        let heldMs = Int((clock.now.timeIntervalSince(since) * 1000).rounded())
        lastUnshown = DebugState.Unshown(offerKey: incoming.offerKey, kind: incoming.kindName, reason: reason.rawValue, heldMs: heldMs)
        emit(.log("\(incoming.kindName) \(incoming.offerKey ?? "(injected)") withdrawn unshown: \(reason.rawValue) after \(heldMs) ms"))
        publish()
        return #"{"held":"\#(reason.rawValue)","unshown":true}"#
    }

    func cancelPending() {
        pendingTimer?.cancel()
        pendingTimer = nil
        pending = nil
        publish()
    }

    // MARK: - Visibility

    /// Nil when a surface for `target` may be drawn at `anchors`; otherwise why not.
    /// `requireFocus: false` is for a line that reports on work, not on a field: the form may have
    /// moved focus on, but the app must be in front and the anchor uncovered.
    func gate(_ target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool, drawnFor: CGRect? = nil) -> SurfaceGate.Hold? {
        let front = world.frontmostPID
        // Cheapest test first: no Accessibility read for an app that is not in front.
        guard front == target.pid else { return .appNotFront }
        var focused = true
        if requireFocus {
            let live = world.focusedIdentity(pid: target.pid)
            focused = live?.elementID == target.elementID && live?.windowID == target.windowID
        }
        let stack = world.windowStack()
        // The app's focused field as it is now, wherever it moved: what a decoration rings. A read
        // that fails (a busy app's Accessibility times out, as TextEdit's did mid-run in A15's Esc
        // runs) says nothing about the ring, so the field the surface was drawn for stands in.
        let live = world.focusedFrame(pid: target.pid)
        let field = live ?? drawnFor
        let hold = SurfaceGate.check(
            targetPID: target.pid, frontmostPID: front, fieldIsFocused: focused, anchors: anchors,
            windows: stack.windows, ownPID: stack.ownPID, displays: stack.displays, field: field
        )
        if hold == .covered {
            let cover = SurfaceGate.cover(targetPID: target.pid, anchors: anchors, windows: stack.windows, ownPID: stack.ownPID, displays: stack.displays, field: field)
            lastCovered = .covered(by: cover?.window, at: cover?.anchor, focusedFrameRead: live != nil)
        }
        return hold
    }

    /// Rechecks what is shown every half second, and on `recheckVisibility` (another app
    /// activated), and acts once when the gate closes.
    func startWatch(_ watched: Watched, target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool, field: CGRect? = nil) {
        stopWatch()
        let timer = clock.schedule(after: Self.recheckInterval, repeats: true) { [weak self] in self?.recheckVisibility() }
        watch = Watch(watched: watched, target: target, anchors: anchors, requireFocus: requireFocus, field: field, timer: timer)
    }

    func stopWatch() {
        watch?.timer.cancel()
        watch = nil
    }

    /// Rechecks the watched surface now. The app calls this when another app activates.
    public func recheckVisibility() {
        guard let watch, let hold = gate(watch.target, anchors: watch.anchors, requireFocus: watch.requireFocus, drawnFor: watch.field) else { return }
        stopWatch()
        switch watch.watched {
        case .offer(let offerID):
            guard let shown, shown.offerID == offerID else { return }
            arbiter.invalidate(offerID: offerID)
            clear(exit: 0)
            count("surface.withdrawn.\(hold.rawValue)")
        case .line:
            // A line nobody can see owns no key: Esc and ⌘Z are the app's again. The work goes on,
            // and the activity list reports it.
            lineSuppressed = true
            lastLineHidden = hold == .covered ? lastCovered : DebugState.LineHidden(hold: hold.rawValue)
            if let work { arbiter.clearStatus(id: work.statusID) }
            endResult()
            hidePanel(exit: 0)
            count("surface.lineHidden.\(hold.rawValue)")
        }
        publish()
    }

    public var isWatching: Bool { watch != nil }

    // MARK: - Drawing decisions

    func draw(ui: OfferUI, entering: Bool) {
        guard let shown else { return }
        switch shown.offer.kind {
        case .ghost where headless:
            let candidates = shown.offer.candidates
            lineText = candidates[min(ui.candidate, candidates.count - 1)]
        case .ghost:
            guard let drawn = world.drawAlternatives(AlternativesDraw(
                offerID: shown.offerID, readID: shown.readID ?? 0, candidates: shown.offer.candidates, ui: ui, entering: entering,
                quoted: shown.quoted, caret: shown.caret, field: shown.field, pid: shown.offer.target.pid, presentation: shown.presentation
            )) else { return withdrawUndrawn(shown) }
            if drawn.capsule != shown.capsule {
                self.shown?.capsule = drawn.capsule
                // A redraw (another candidate on ↓) can move the capsule: watch where it is now.
                if let watch, watch.watched == .offer(shown.offerID), let now = self.shown {
                    startWatch(watch.watched, target: watch.target, anchors: Self.watchAnchors(now), requireFocus: watch.requireFocus, field: watch.field)
                }
            }
        case .action(let line):
            if ui.expanded, let variants = line.variants {
                showOffer(.popup(variants, highlight: ui.highlight), text: variants.header?.title.text, figure: .needsYou, at: shown, entering: entering)
            } else {
                let content: PanelContent = ui.compact ? .compactLine(CompactOffer.line(line)) : .line(Self.lineContent(line))
                showOffer(content, text: "\(line.app) \(line.endState.text)", figure: .offering, at: shown, entering: entering)
            }
        case .popup:
            guard let spec = shown.offer.visibleSpec(ui: ui) else { return }
            if ui.compact {
                let line = CompactOffer.line(spec, highlight: ui.highlight)
                showOffer(.compactLine(line), text: line.text, figure: line.figure, at: shown, entering: entering)
            } else {
                showOffer(.popup(spec, highlight: ui.highlight), text: spec.header?.title.text,
                          figure: spec.figure == .needsYou ? .needsYou : .offering, at: shown, entering: entering)
            }
        case .fill, .writing:
            break
        }
        publish()
    }

    /// Alternatives the renderer could not put on screen: withdrawn at once, so Tab, the arrows and
    /// Esc stay the app's, and logged as an unshown offer.
    func withdrawUndrawn(_ shown: Shown) {
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0)
        count("surface.held.\(SurfaceGate.Hold.notDrawn.rawValue)")
        count("surface.unshown.\(SurfaceGate.Hold.notDrawn.rawValue)")
        lastUnshown = DebugState.Unshown(offerKey: shown.offerKey, kind: shown.offer.kind.name, reason: SurfaceGate.Hold.notDrawn.rawValue, heldMs: 0)
        emit(.log("\(shown.offer.kind.name) \(shown.offerKey ?? "(injected)") \(shown.presentation.rawValue) withdrawn unshown: \(SurfaceGate.Hold.notDrawn.rawValue)"))
        publish()
    }

    /// An action line as the panel draws it.
    static func lineContent(_ line: ActionLine) -> LineContent {
        LineContent(figure: .offering, app: line.app, text: line.endState.text, hints: Hint.hints(line.actions))
    }

    /// What an action line or pop-up first draws on the panel; nil for what is drawn at the caret.
    static func panelContent(for offer: Offer) -> PanelContent? {
        switch offer.kind {
        case .action(let line): return .line(lineContent(line))
        case .popup(let popup): return .popup(popup.spec, highlight: OfferUI(initialFor: offer).highlight)
        case .ghost, .fill, .writing: return nil
        }
    }

    /// The same offer as its compact line.
    static func compactContent(for offer: Offer, ui: OfferUI) -> PanelContent? {
        switch offer.kind {
        case .action(let line): return .compactLine(CompactOffer.line(line))
        // S1, H11: a pop-up that writes a saved answer shows it whole before Tab, so it never shrinks to a line
        // whose Tab takes it unseen; with no clear spot for the card it is not drawn at all.
        case .popup(let popup): return popup.spec.carriesSavedAnswer ? nil : .compactLine(CompactOffer.line(popup.spec, highlight: ui.highlight))
        case .ghost, .fill, .writing: return nil
        }
    }

    /// The offer line or pop-up on the panel, around the offer's field.
    func showOffer(_ content: PanelContent, text: String?, figure: FigureState, at shown: Shown, entering: Bool) {
        lineText = text
        self.figure = figure
        guard !headless else { return }
        showPanel(content, text: text ?? "", placement: .atField(field: shown.field, caret: shown.caret, pid: shown.offer.target.pid, entering: entering))
    }

    func showPanel(_ content: PanelContent, text: String, placement: PanelPlacementRequest) {
        emit(.showPanel(content, text: text, placement: placement))
        panelUp = true
        panelExitEnds = nil
    }

    func hidePanel(exit: TimeInterval) {
        guard !headless else { return }
        let fading = panelExitEnds.map { clock.now < $0 } ?? false
        guard panelUp || fading else { return }
        emit(.hidePanel(exit: exit))
        panelUp = false
        panelExitEnds = clock.now.addingTimeInterval(exit)
    }

    func takeLineDown(exit: TimeInterval) {
        hidePanel(exit: exit)
        lineText = nil
        figure = nil
    }

    /// Takes the shown offer down. The line on the panel goes with it unless work or a result
    /// holds the panel.
    func clear(exit: TimeInterval) {
        stopWatch()
        guard let shown else { return }
        if !headless { emit(.clearCaret(offerID: shown.offerID)) }
        if work == nil, resultTimer == nil { takeLineDown(exit: exit) }
        self.shown = nil
    }

    // MARK: - Keys (the tap thread's decisions, on main)

    public func navigated(offerID: UInt64, ui: OfferUI) {
        guard let shown, shown.offerID == offerID else { return }
        draw(ui: ui, entering: false)
    }

    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        let snapshot = arbiter.snapshot()
        if let q = question, q.state == .asked, snapshot.current?.id != q.offerID {
            // A key that passed through took it unanswered, as typing on dismisses every offer. Esc
            // answered it already (`offerClosed`, which runs first).
            question = nil
            asked[q.offerID] = nil
            count("surface.skill.dismissed")
        }
        if reason == .typedThrough, let shown, snapshot.current?.id == shown.offerID {
            // The user typed the head of the top candidate: the rest stays as ghost text, and the
            // other candidates no longer fit, so their underline and list go.
            let typed = snapshot.typedSinceOffer
            emit(.typedThrough(offerID: shown.offerID, typed: typed, remainder: String(shown.offer.text.dropFirst(typed.count)), caret: shown.caret))
            return publish()
        }
        if let shown, snapshot.current?.id != shown.offerID {
            // Typing: 80 ms (the text itself at once). Esc: 100 ms.
            clear(exit: reason == .closed ? 0.10 : 0.08)
        }
        if let work, snapshot.statusLine?.id != work.statusID, panelUp {
            // A key passed through and dismissed the working line; the work goes on unseen and
            // its result still reports.
            hidePanel(exit: 0.08)
        }
        if let toastGrantID, snapshot.toast?.id != toastGrantID {
            // Esc closed the fill toast, or a key passed through and dismissed it; ⌘Z is the
            // app's again.
            self.toastGrantID = nil
            toastInfo = nil
            cancelResultTimer()
            takeLineDown(exit: 0.08)
        } else if resultTimer != nil, undoing == nil, snapshot.statusLine?.id != resultStatusID {
            cancelResultTimer()
            takeLineDown(exit: 0.08)
        }
        publish()
    }

    /// Another producer's offer replaced this one in the arbiter.
    public func displaced(_ offer: Offer) {
        if let q = question, q.offerID == offer.id, q.state == .asked {
            question = nil
            count("surface.skill.displaced")
            redrawResult()
            return publish()
        }
        guard let shown, offer.id == shown.offerID else { return }
        clear(exit: 0.10)
        publish()
    }

    /// The frontmost app's focused field changed. An offer bound to another field of that app is
    /// withdrawn: its panel describes a field the user has left.
    public func focusChanged(_ identity: TargetIdentity?) {
        guard let shown, let identity, identity.pid == shown.offer.target.pid,
              identity.elementID != shown.offer.target.elementID else { return }
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0.10)
        count("surface.withdrawn.focusMoved")
        publish()
    }

    public func claimed(_ claim: Claim) {
        // A question's Tab, by the claim's own offer: answered even if main took the line down since.
        if claim.offer.kind.actionLine?.answersToast == true { return answer(claim.offer.id, .accept) }
        releaseWhatTheKeyCleared()
        let shown: Shown
        if let current = self.shown, current.offerID == claim.offer.id {
            shown = current
        } else if !claim.insertsText, let earlier = displacedShown, earlier.offerID == claim.offer.id {
            // The tap took this offer's action, and a newer offer was drawn before this ran. The
            // key was pressed on the offer the user saw, so that one is taken and the newer gives way.
            if let newer = self.shown {
                arbiter.invalidate(offerID: newer.offerID)
                clear(exit: 0)
            }
            shown = earlier
            count("surface.claimAfterReplace")
        } else {
            return
        }
        displacedShown = nil
        // An action is about the field it was offered in. Revalidate that field before handing
        // the action on: focus may have moved in an app that posts no focus notification. A
        // headless host reads no field; its offers are bound to the field the helper named.
        if !claim.insertsText, !headless {
            let live = world.focusedIdentity(pid: claim.offer.target.pid)
            if live?.elementID != claim.offer.target.elementID || live?.windowID != claim.offer.target.windowID {
                arbiter.abandon(claimID: claim.claimID, reason: "targetMoved")
                clear(exit: 0.10)
                count("surface.refused.targetMoved")
                return publish()
            }
        }
        if claim.insertsText {
            // Alternatives: the chosen text is on its way into the field; nothing animates. The
            // helper sees the value arrive as a transfer, so nothing is sent.
            clear(exit: 0)
            lastAccepted = Accepted(
                offerKey: shown.offerKey, candidate: claim.choice.candidate, source: claim.offer.source.rawValue, kind: claim.offer.kind.name
            )
            return publish()
        }
        let accept = OfferAccept.from(claim, at: nowMs)
        lastAccepted = Accepted(
            offerKey: accept?.offerId, actionId: accept?.actionId, row: claim.choice.row,
            overrides: accept?.overrides, source: claim.offer.source.rawValue, kind: claim.offer.kind.name
        )
        // H8: the first event card accepted asks macOS for Calendar access before the helper hears of it,
        // so the reader, which never asks, finds the answer in place. Never at launch, never for a card
        // only shown: Tab is the user asking for the event.
        let asks = claim.offer.source == .helper && accept != nil && claim.offer.kind.actionLine?.eventCard == true && calendarAccessUndetermined()
        let unsent = !asks && claim.offer.source == .helper && accept.map { !sendToHelper(.accept($0)) } == true
        // The panel stays: the line, in place, becomes the working caption.
        if !headless { emit(.clearCaret(offerID: shown.offerID)) }
        stopWatch()
        self.shown = nil
        startWork(claim, offerKey: accept?.offerId ?? "?")
        work?.anchor = Anchor(field: shown.field, caret: shown.caret)
        if asks, let accept {
            calendarHeld = accept
            count("surface.calendar.asked")
            emit(.askCalendarAccess)
        }
        guard !headless else { return unsent ? failUnsent() : publish() }
        // The working line and its result follow the same rule as the offer: the app in front and
        // the line's anchor uncovered. Focus may move; the line reports on work, not on a field.
        // H8: macOS's Calendar prompt takes the front, which would take the line down for good (VM run 6:
        // the done line and its ⌘Z never came back). Its watch starts when macOS answers.
        if !asks { watchLine() }
        if unsent { return failUnsent() }
        publish()
    }

    /// The working line, watched as an offer is: hidden while its app is not in front or its anchor is covered.
    func watchLine() {
        guard let work, let anchor = work.anchor else { return }
        startWatch(.line, target: work.target, anchors: [CGPoint(x: anchor.caret.midX, y: anchor.caret.midY)], requireFocus: false, field: anchor.field)
    }

    /// macOS answered the Calendar prompt `askCalendarAccess` raised, either way: a refusal still sends
    /// the accept, and the reader's `blocked: tcc` ends it on the line that says where to allow access.
    /// Nothing is sent when the work it was for ended while macOS asked (Esc, the helper going).
    public func calendarAccessAnswered() {
        guard let held = calendarHeld, work?.offerKey == held.offerId else { return }
        calendarHeld = nil
        var accept = held
        accept.at = nowMs
        if !headless, let work, let anchor = work.anchor {
            // The app the card was accepted in gets the front back only after the answer (VM run 7: still
            // UserNotificationCenter's when it came), so the watch starts a moment later, for the working
            // line or the done line that may have replaced it by then.
            let target = work.target
            let key = work.offerKey
            calendarWatchToken &+= 1
            let token = calendarWatchToken
            _ = clock.schedule(after: Self.calendarFrontGrace, repeats: false) { [weak self] in
                guard let self, self.calendarWatchToken == token, self.work?.offerKey == key || self.result?.taskID == key else { return }
                self.startWatch(.line, target: target, anchors: [CGPoint(x: anchor.caret.midX, y: anchor.caret.midY)], requireFocus: false, field: anchor.field)
            }
        }
        guard sendToHelper(.accept(accept)) else { return failUnsent() }
        publish()
    }

    /// `offerAccept` was not written: the working line becomes the helper-down line at once.
    private func failUnsent() {
        count("surface.accept.unsent")
        end(with: .helperDown)
    }

    /// A Tab that took another owner's offer (the fill line's) also cleared this machine's working
    /// line and toast in the arbiter, as any key headed for their app does. Without this the
    /// toast stayed on screen reading "⌘Z Undo" while ⌘Z belonged to the app again (A7 finding,
    /// `SharedToastSlotTests`).
    func releaseWhatTheKeyCleared() {
        let snapshot = arbiter.snapshot()
        if let work, snapshot.statusLine?.id != work.statusID, panelUp { hidePanel(exit: 0.08) }
        if let toastGrantID, snapshot.toast?.id != toastGrantID {
            self.toastGrantID = nil
            toastInfo = nil
            cancelResultTimer()
            takeLineDown(exit: 0.08)
        } else if resultTimer != nil, undoing == nil, snapshot.statusLine?.id != resultStatusID {
            // A result or error line the key dismissed, as `offerChanged` takes it down.
            cancelResultTimer()
            takeLineDown(exit: 0.08)
        }
    }

    /// The settings closed the gate (pause): the offer shown or held goes, and nothing held is
    /// retried. Work already accepted goes on; its line and toast stay.
    public func gateClosed() {
        dropQuestion("surface.skill.gateClosed")
        redrawResult()
        cancelPending()
        guard let shown else { return publish() }
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0.10)
        count("surface.withdrawn.gateClosed")
        publish()
    }

    public func shutdown() {
        for timer in stopDeadlines.values { timer.cancel() }
        stopDeadlines.removeAll()
        dropQuestion("surface.skill.shutdown")
        cancelPending()
        endSwap(takeDown: false)
        stopWatch()
        endWork()
        endResult()
        clear(exit: 0)
        hidePanel(exit: 0)
    }

    // MARK: - Debug state

    /// What the machine knows of the surface state. The drawing layer adds what only it can see
    /// (the panels' frames, the ghost text drawn).
    public func debugInfo() -> DebugState.SurfaceInfo {
        let snapshot = arbiter.snapshot()
        var info = DebugState.SurfaceInfo()
        info.headless = headless
        if let q = question {
            info.question = q.row.text
            info.questionAnswered = q.answered
        }
        if work?.unprompted == true { info.unprompted = true }
        info.lineHidden = lastLineHidden
        if let p = shownProvenance {
            info.provenance = p.facts.first?.says
            info.provenanceFacts = p.facts.count
        }
        if let shown {
            info.offerId = shown.offerID
            info.offerKey = shown.offerKey
            info.kind = shown.offer.kind.name
            info.source = shown.offer.source.rawValue
            info.candidates = shown.offer.candidates.count > 1 || shown.offer.kind == .ghost ? shown.offer.candidates : nil
            info.ui = snapshot.current?.id == shown.offerID ? snapshot.ui : nil
            if case .ghost = shown.offer.kind { info.caretPresentation = shown.presentation.rawValue }
            // H8: where Tab would put a shown event card's event, as its card says it.
            if case .action(let line) = shown.offer.kind, line.eventCard, let card = line.variants { info.eventDestination = EventCardCopy.destinationLine(card) }
        }
        info.figure = figure?.rawValue
        info.character = world.character.rawValue
        info.lineText = headless ? lineText : nil
        // Headless runs draw nothing, so a pop-up's rows are read from what VoiceOver would say of it (H5:
        // a control the user sets reads "you set this").
        if headless, let shown, case .popup(let popup) = shown.offer.kind { info.popupSpoken = SlipSpeech.popup(popup.spec, highlight: nil) }
        info.working = work.map { clock.now.timeIntervalSince($0.startedAt) }
        info.workingOn = work?.offerKey
        info.workCaret = work?.anchor.map { [$0.caret.minX, $0.caret.minY, $0.caret.width, $0.caret.height].map(Double.init) }
        info.toast = toastInfo
        info.held = pending?.hold.rawValue
        info.lastUnshown = lastUnshown
        info.lastAccepted = lastAccepted.map {
            DebugState.AcceptInfo(offerKey: $0.offerKey, actionId: $0.actionId, candidate: $0.candidate, row: $0.row, overrides: $0.overrides, source: $0.source, kind: $0.kind)
        }
        return info
    }

    /// Why the held offer waits, if one does.
    public var held: SurfaceGate.Hold? { pending?.hold }
    public var workingOn: String? { work?.offerKey }
}
