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
    /// How long a held offer is retried before it is dropped. Assumed, not measured.
    public static let holdLimit: TimeInterval = 30

    let arbiter: OfferArbiter
    let world: SurfaceWorld
    let clock: SurfaceClock
    public let headless: Bool
    /// Where commands go. Set once, before offers flow.
    public var output: (SurfaceCommand) -> Void = { _ in }
    /// Sends to the helper; true when written. Set once, before offers flow.
    public var sendToHelper: (SurfaceSend) -> Bool = { _ in false }

    public internal(set) var shown: Shown?
    /// The offer a newer one replaced on the panel, kept until the next replacement: a Tab the tap
    /// took on it may reach main after the newer offer was drawn (`claimed`).
    var displacedShown: Shown?
    /// An offer held by `SurfaceGate`, retried until it may be drawn, it is withdrawn, or 30 s pass.
    var pending: Pending?
    var pendingTimer: SurfaceTimer?
    var watch: Watch?
    var work: Work?
    var swap: Swap?
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
    public internal(set) var lastAccepted: Accepted?
    /// What the panel says, and its figure. Kept on a headless host too, for the debug state.
    public internal(set) var lineText: String?
    public internal(set) var figure: FigureState?
    /// The panel was last told to show, not to hide.
    public internal(set) var panelUp = false
    /// When the panel's last exit finishes. Until then a hide still goes out: an immediate one
    /// cuts a running fade short, so an old line does not fade over a new offer.
    var panelExitEnds: Date?

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
        let candidates = incoming.candidates
        if !candidates.isEmpty, let frame = field.frame {
            // Ghost text stays inside the field, clear of the app's own text: the widest candidate
            // must fit after the caret with nothing after it. The caret's own height, not 3 pt
            // more for the underline: in a single-line field that holds text, KeyType estimates
            // the caret flush with the field's bottom edge (AXCaretGeometryResolver, single-line
            // branch), and A10's filled-field run held every alternative as wouldOverlapText.
            let widest = candidates.map { world.textWidth($0, readID: field.readID) }.max() ?? 0
            let ghostRect = CGRect(x: caret.maxX, y: caret.minY, width: widest, height: caret.height)
            let textAfter = field.selection.end < UTF16Text.length(field.value)
            if !SurfaceGate.fitsInField(ghost: ghostRect, field: frame, textAfterCaret: textAfter) {
                return hold(incoming, .wouldOverlapText, retry: false)
            }
        }
        guard let offer = incoming.offer(for: field, createdAt: clock.now) else { return #"{"error":"nothing to show"}"# }
        if let reply = replaceInPlace(incoming, with: offer, caret: caret, field: field.frame ?? caret, readID: field.readID) {
            startWatch(.offer(shown!.offerID), target: field.identity, anchors: anchors, requireFocus: true)
            return reply
        }
        let swapping = incoming.helperKey != nil && swap?.newKey == incoming.helperKey
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
            offerID: offerID, offer: stamped, offerKey: incoming.offerKey, caret: caret, field: field.frame ?? caret,
            quoted: incoming.quoted, readID: field.readID
        )
        // A reoffered line's replacement is drawn over it where it stands, without an exit and entry.
        draw(ui: arbiter.snapshot().ui, entering: !swapping)
        if swapping { count("surface.reoffer.swapped") }
        startWatch(.offer(offerID), target: field.identity, anchors: anchors, requireFocus: true)
        count("surface.shown.\(offer.source.rawValue).\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

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
    func replaceInPlace(_ incoming: SurfaceIncoming, with offer: Offer, caret: CGRect, field: CGRect, readID: UInt64?) -> String? {
        guard let shown, shown.offer.source == .helper, let key = incoming.helperKey, shown.offerKey == key,
              case .ghost = offer.kind, case .ghost = shown.offer.kind,
              let ui = arbiter.replace(offerID: shown.offerID, with: offer) else { return nil }
        cancelPending()
        let stamped = arbiter.snapshot().current.flatMap { $0.id == shown.offerID ? $0 : nil } ?? offer
        self.shown = Shown(
            offerID: shown.offerID, offer: stamped, offerKey: key, caret: caret, field: field,
            quoted: incoming.quoted, readID: readID ?? shown.readID
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

    /// Nothing is drawn; the offer waits, and is tried again every half second for 30 s (or not at
    /// all when only the field's own content could change the answer).
    func hold(_ incoming: SurfaceIncoming, _ reason: SurfaceGate.Hold, retry: Bool = true) -> String {
        count("surface.held.\(reason.rawValue)")
        // A reoffered line whose replacement cannot be drawn now goes, rather than sit with no key.
        if let key = incoming.helperKey, swap?.newKey == key { endSwap(takeDown: true) }
        if !retry {
            // Only the field's own content could change the answer; an older held offer is
            // superseded too, so nothing is retried.
            pendingTimer?.cancel()
            pendingTimer = nil
            pending = nil
        } else {
            // The same offer keeps its first hold time; a different one starts over.
            let since = pending.flatMap { $0.incoming.offerKey == incoming.offerKey ? $0.since : nil } ?? clock.now
            pending = Pending(incoming: incoming, since: since, hold: reason)
            if pendingTimer == nil {
                pendingTimer = clock.schedule(after: Self.recheckInterval, repeats: true) { [weak self] in self?.retryPending() }
            }
        }
        publish()
        return #"{"held":"\#(reason.rawValue)"}"#
    }

    func retryPending() {
        guard let pending else { return cancelPending() }
        if clock.now.timeIntervalSince(pending.since) > Self.holdLimit { return cancelPending() }
        _ = present(pending.incoming)
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
    func gate(_ target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) -> SurfaceGate.Hold? {
        let front = world.frontmostPID
        // Cheapest test first: no Accessibility read for an app that is not in front.
        guard front == target.pid else { return .appNotFront }
        var focused = true
        if requireFocus {
            let live = world.focusedIdentity(pid: target.pid)
            focused = live?.elementID == target.elementID && live?.windowID == target.windowID
        }
        let stack = world.windowStack()
        return SurfaceGate.check(
            targetPID: target.pid, frontmostPID: front, fieldIsFocused: focused, anchors: anchors,
            windows: stack.windows, ownPID: stack.ownPID, displays: stack.displays
        )
    }

    /// Rechecks what is shown every half second, and on `recheckVisibility` (another app
    /// activated), and acts once when the gate closes.
    func startWatch(_ watched: Watched, target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) {
        stopWatch()
        let timer = clock.schedule(after: Self.recheckInterval, repeats: true) { [weak self] in self?.recheckVisibility() }
        watch = Watch(watched: watched, target: target, anchors: anchors, requireFocus: requireFocus, timer: timer)
    }

    func stopWatch() {
        watch?.timer.cancel()
        watch = nil
    }

    /// Rechecks the watched surface now. The app calls this when another app activates.
    public func recheckVisibility() {
        guard let watch, let hold = gate(watch.target, anchors: watch.anchors, requireFocus: watch.requireFocus) else { return }
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
            emit(.drawAlternatives(AlternativesDraw(
                offerID: shown.offerID, readID: shown.readID ?? 0, candidates: shown.offer.candidates, ui: ui, entering: entering,
                quoted: shown.quoted, caret: shown.caret, field: shown.field, pid: shown.offer.target.pid
            )))
        case .action(let line):
            if ui.expanded, let variants = line.variants {
                showOffer(.popup(variants, highlight: ui.highlight), text: variants.header?.title.text, figure: .needsYou, at: shown, entering: entering)
            } else {
                let content = LineContent(figure: .offering, app: line.app, text: line.endState.text, hints: Hint.hints(line.actions))
                showOffer(.line(content), text: "\(line.app) \(line.endState.text)", figure: .offering, at: shown, entering: entering)
            }
        case .popup:
            guard let spec = shown.offer.visibleSpec(ui: ui) else { return }
            showOffer(.popup(spec, highlight: ui.highlight), text: spec.header?.title.text,
                      figure: spec.figure == .needsYou ? .needsYou : .offering, at: shown, entering: entering)
        case .fill:
            break
        }
        publish()
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
        let unsent = claim.offer.source == .helper && accept.map { !sendToHelper(.accept($0)) } == true
        // The panel stays: the line, in place, becomes the working caption.
        if !headless { emit(.clearCaret(offerID: shown.offerID)) }
        stopWatch()
        self.shown = nil
        startWork(claim, offerKey: accept?.offerId ?? "?")
        guard !headless else { return unsent ? failUnsent() : publish() }
        // The working line and its result follow the same rule as the offer: the app in front and
        // the line's anchor uncovered. Focus may move; the line reports on work, not on a field.
        startWatch(.line, target: claim.offer.target, anchors: [CGPoint(x: shown.caret.midX, y: shown.caret.midY)], requireFocus: false)
        if unsent { return failUnsent() }
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
        cancelPending()
        guard let shown else { return publish() }
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0.10)
        count("surface.withdrawn.gateClosed")
        publish()
    }

    public func shutdown() {
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
        if let shown {
            info.offerId = shown.offerID
            info.offerKey = shown.offerKey
            info.kind = shown.offer.kind.name
            info.source = shown.offer.source.rawValue
            info.candidates = shown.offer.candidates.count > 1 || shown.offer.kind == .ghost ? shown.offer.candidates : nil
            info.ui = snapshot.current?.id == shown.offerID ? snapshot.ui : nil
        }
        info.figure = figure?.rawValue
        info.character = world.character.rawValue
        info.lineText = headless ? lineText : nil
        info.working = work.map { clock.now.timeIntervalSince($0.startedAt) }
        info.workingOn = work?.offerKey
        info.toast = toastInfo
        info.held = pending?.hold.rawValue
        info.lastAccepted = lastAccepted.map {
            DebugState.AcceptInfo(offerKey: $0.offerKey, actionId: $0.actionId, candidate: $0.candidate, row: $0.row, overrides: $0.overrides, source: $0.source, kind: $0.kind)
        }
        return info
    }

    /// Why the held offer waits, if one does.
    public var held: SurfaceGate.Hold? { pending?.hold }
    public var workingOn: String? { work?.offerKey }
}
