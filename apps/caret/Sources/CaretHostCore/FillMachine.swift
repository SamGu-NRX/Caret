import CaretScreenCore
import CoreGraphics
import Foundation

/// Why a fill evaluation ran, for the latency the debug state reports.
public enum FillTrigger: Equatable, Sendable {
    /// A proposal arrived at this uptime (nanoseconds).
    case proposal(UInt64)
    /// The form's app notified a focus or value change at this uptime.
    case focus(UInt64)
    /// Anything else: an app came to the front, or a write just landed.
    case other
}

/// The focused field of an app, read through Accessibility and reduced to plain values.
public struct FillFieldRead: Equatable, Sendable {
    public var identity: TargetIdentity
    public var value: String
    public var selection: UTF16Selection
    public var secure: Bool
    /// Global points, top-left origin.
    public var frame: CGRect
    /// Names this read, so the drawing layer can find the element's font and placeholder.
    public var readID: UInt64

    public init(identity: TargetIdentity, value: String, selection: UTF16Selection, secure: Bool, frame: CGRect, readID: UInt64 = 0) {
        self.identity = identity
        self.value = value
        self.selection = selection
        self.secure = secure
        self.frame = frame
        self.readID = readID
    }
}

/// What `FillMachine` asks of the system. CaretHost answers from NSWorkspace, Accessibility and
/// the window server; tests answer from a fake.
public protocol FillWorld: AnyObject {
    /// `TargetPolicy`: the pid (and its bundle, when known) may be offered into.
    func allows(pid: Int32, bundleID: String?) -> Bool
    /// NSWorkspace's frontmost app.
    var frontmostPID: Int32? { get }
    func bundleID(pid: Int32) -> String?
    /// The app's focused field. Nil when it cannot be read or reports no frame.
    func focusedField(pid: Int32) -> FillFieldRead?
    /// `Visibility.hold`: nil when a surface for `target` may be drawn at `anchors`.
    func hold(for target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) -> SurfaceGate.Hold?
    /// Whether a fill's source window is still open: its app runs and has a window with that title.
    /// Nil when the source names no process to look in. Cheap: one app's window titles, no walk.
    func sourceOpen(_ source: FillOrigin.Window) -> Bool?
    /// The element (`TargetIdentity.elementID`) at each of `frames` in the app now, by the key it
    /// was given: hit-tested at the frame's center and kept only when an element there, or one of
    /// its two nearest ancestors, has that frame (`FillSelection.matches`) and lies in the window
    /// `windowID` names (`TargetIdentity.windowID`). Keys with no such element are left out.
    /// Time-boxed; a slow app gives fewer keys, never a wrong one.
    func elementIDs(pid: Int32, at frames: [String: Frame], window windowID: String) -> [String: String]
    /// H10: the page field the user is in, in this browser process (`PageFocusBook`), while the page has the browser's
    /// focus: nil when no page control has focus, or the browser's own toolbar does (Accessibility then names it).
    func pageFocus(pid: Int32) -> PageField?
}

/// The ghost value in the field and its source line.
public struct FillDraw: Equatable, Sendable {
    public var offerID: UInt64
    public var value: String
    /// The field's frame, global top-left points.
    public var field: CGRect
    /// "from Mail, Invoice 2041".
    public var caption: String
    public var pid: Int32
    /// The field read the value is drawn against (`FillFieldRead.readID`).
    public var readID: UInt64
    /// What becomes of a toast still up (`FillLineRule`), decided here so the overlay only draws.
    public var line: FillLineRule.Outcome
    /// The source window's app, for its glyph in the slip; nil for a value from memory.
    public var sourceApp: String? = nil
    /// ⌘1 fills the form (`FillOrigin.fillAll`): the slip shows its key.
    public var fillAll = false
}

/// The line after Tab or ⌘Z, in place of the offer's line.
public struct FillToastDraw: Equatable, Sendable {
    public enum Kind: String, Sendable { case done, undone, error }
    public var kind: Kind
    /// Set in Carrot text before the rest ("Filled").
    public var lead: String?
    public var text: String
    public var keycap: Hint?
    public var field: CGRect?
    public var pid: Int32
    /// The source of the fill it reports, which `FillLineRule` compares with the next offer's.
    public var source: String
}

/// What `FillMachine` tells the drawing layer and the helper link to do.
public enum FillCommand: Equatable, Sendable {
    /// Start or stop watching an app's focus and value changes (`FillTargetWatcher`).
    case watchApp(Int32)
    case unwatchApp(Int32)
    case drawOffer(FillDraw)
    case hideOffer(byTyping: Bool)
    /// Tab took the value: the ghost goes, the line stays for the result.
    case markWorking
    /// ⌘1 on the slip: send `fillAll` for the proposal (D2-04).
    case fillAll(String)
    /// H10: Tab on a page field's offer: send `fillAll` for that field alone; the helper writes it.
    case fillField(proposalID: String, fieldKey: String)
    /// H10: ⌘Z on the toast of a fill the helper ran: send `taskControl` undo for its task.
    case undoTask(String)
    /// A line for the host's log: why a proposal was refused, never silently (H10).
    case log(String)
    case drawToast(FillToastDraw)
    /// The toast ends; a line waiting behind it (`FillLineRule.deferLine`) takes the stage.
    case hideToast(byTyping: Bool)
    case hideAll
    /// The insertion queue keeps the target's app with the offer, for the write.
    case remember(offerID: UInt64, bundleID: String)
    /// This machine's toast took the arbiter's one toast slot; a pop-up's toast must give way.
    case toastSlotTaken
    case send(FillResult)
    /// An offer was published after this trigger, for the latency summaries.
    case offerShown(FillTrigger)
    case count(String)
    /// The debug state changed; republish `status`.
    case publish
}

/// What became of a fill's write, as the insertion queue reports it.
public struct FillInsertion: Equatable, Sendable {
    public var claim: Claim
    public var verified: Bool
    public var rejected: Bool
    public var reason: String?
    public var method: FillResult.Method?
    /// What ⌘Z may revert while the toast is up: a verified fill's, or an unconfirmed one's whose
    /// field held the whole value or only part of it (`UnconfirmedInsert.grant`).
    public var undo: UndoGrant?
    public var insertedLength: Int
    /// The field a paste landed in instead, by its label (`wroteElsewhere`).
    public var strayField: String?
    /// For a write Caret could not confirm: what a read of the field found afterwards (S2).
    public var recovery: UnconfirmedInsert.Report?

    public init(
        claim: Claim, verified: Bool, rejected: Bool, reason: String?, method: FillResult.Method?, undo: UndoGrant?, insertedLength: Int,
        strayField: String? = nil, recovery: UnconfirmedInsert.Report? = nil
    ) {
        self.claim = claim
        self.verified = verified
        self.rejected = rejected
        self.reason = reason
        self.method = method
        self.undo = undo
        self.insertedLength = insertedLength
        self.strayField = strayField
        self.recovery = recovery
    }
}

/// What became of ⌘Z on a fill's toast.
public struct FillUndo: Equatable, Sendable {
    public var grant: UndoGrant
    public var ok: Bool
    public var error: String?
    /// ⌘Z took out only the part of the fill that had gone in (S1's partial write).
    public var partial: Bool
    /// For an unconfirmed fill's field that ⌘Z left alone: what it holds and held, in S1's words.
    public var says: String?

    public init(grant: UndoGrant, ok: Bool, error: String?, partial: Bool = false, says: String? = nil) {
        self.grant = grant
        self.ok = ok
        self.error = error
        self.partial = partial
        self.says = says
    }
}

/// The decisions of grounded fill: which proposal and field to offer, when to hold or withdraw the
/// offer, what its result toast says, how long it and its ⌘Z live, and what is reported to the
/// helper (`SURFACES.md` sections 5 and 6).
///
/// The helper proposes once per form (one entry per empty field) and then stays quiet for that
/// form for 30 s, so the machine keeps the latest proposal per window and re-evaluates it on every
/// focus or value change in the form's app. The system comes in through `FillWorld`; drawing and
/// sending go out as `FillCommand`; time comes from a `SurfaceClock`. Invariant: a fill value is on
/// screen exactly when the arbiter holds the fill offer it was drawn for.
///
/// The toast shares the arbiter's one toast slot with `SurfaceMachine`'s fill pop-up toast: each
/// says `toastSlotTaken` when it takes the slot, and the other's `toastChanged` gives way.
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class FillMachine {
    public struct Status: Equatable, Sendable {
        public var cachedProposals = 0
        public var lastProposalID: String?
        public var lastProposalFields: Int?
        public var lastProposalValues: Int?
        public var lastSkip: String?
        public var lastResult: FillResult?
        public var toast: DebugState.Toast?
        public var offersShown: UInt64 = 0

        public init() {}

        /// Copies the machine's fields into the debug state, leaving the drawing layer's own.
        public func apply(to fill: inout DebugState.FillStatus) {
            fill.cachedProposals = cachedProposals
            fill.lastProposalID = lastProposalID
            fill.lastProposalFields = lastProposalFields
            fill.lastProposalValues = lastProposalValues
            fill.lastSkip = lastSkip
            fill.lastResult = lastResult
            fill.toast = toast
            fill.offersShown = offersShown
        }
    }

    struct Held {
        let proposal: FillProposal
        /// The form's process (`FillSelection.formProcess`).
        let pid: Int32
        let receivedAt: Date
        /// Each proposed field's element, found where the proposal put it, by field key. Bound once,
        /// at the first evaluation while its app is in front (`bind`).
        var bound: [String: String] = [:]
        var bindAttempts = 0
    }

    /// Binding is tried this many times per proposal while some fields stay unbound (one off
    /// screen, or a slow app's time ran out). Assumed: each try costs up to `bindBudget` of main
    /// thread, and a form rarely needs more than a scroll or two to show every field.
    static let bindAttempts = 3

    struct Toast {
        let source: String
        /// The undo grant while ⌘Z can still take it.
        var grantID: UInt64?
        let timer: SurfaceTimer
    }

    struct Watch {
        let target: TargetIdentity
        let anchors: [CGPoint]
        let requireFocus: Bool
        let timer: SurfaceTimer
    }

    /// A held proposal is used for at most this long. Assumed: the helper re-proposes a form after
    /// 30 s of quiet, and its values are rechecked against the source before every write anyway.
    public static let proposalMaxAge: TimeInterval = 120
    /// The visibility recheck, as `SurfaceMachine.recheckInterval` (assumed, not measured).
    public static let recheckInterval: TimeInterval = 0.5
    /// After a write, the form is read again this soon, in case the app posts nothing for a
    /// programmatic focus change.
    public static let rereadAfterWrite: TimeInterval = 0.05
    /// Error toasts live longer than results so the next step can be read (`SURFACES.md` 6).
    public static let errorLifetime: TimeInterval = 6
    public static let undoneLifetime: TimeInterval = 2

    let arbiter: OfferArbiter
    let world: FillWorld
    let clock: SurfaceClock
    /// Where commands go. Set once, before proposals flow.
    public var output: (FillCommand) -> Void = { _ in }

    public private(set) var status = Status()
    var held: [String: Held] = [:]
    public private(set) var shownOfferID: UInt64?
    /// What the shown offer is for, so a repeat evaluation of the same state does not republish.
    var shownKey: String?
    var lastFieldFrame: CGRect?
    /// Values refused or undone, per field (`FillSelection.suppressionKey`).
    var suppressed: Set<String> = []
    /// Proposals a field of which went in by Tab, written or failed: a Fill all of them would find
    /// a destination no longer empty, which the helper refuses (H6 review).
    var tabbed: Set<String> = []
    /// When each memory entry was last edited, paused or forgotten. The helper cannot take back one
    /// field of a proposal it sent, so a held proposal's value from an entry changed after it
    /// arrived is skipped here; entries older than `proposalMaxAge` are dropped with the proposals.
    var memoryChangedAt: [String: Date] = [:]
    var toast: Toast?
    var watch: Watch?
    /// The read after a write, per app.
    var rereads: [Int32: SurfaceTimer] = [:]
    /// H10: fills the helper runs for this machine, by task id: Tab on a page field, and ⌘1 on any form.
    var helperFills: [String: HelperFill] = [:]

    struct HelperFill {
        let origin: FillOrigin
        let target: TargetIdentity
        let field: CGRect?
        /// Tab on one field (a page's), not ⌘1 on the form.
        let oneField: Bool
        /// The value offered, for the suppression of a failed one (as a failed Tab's, `insertionFinished`).
        let value: String
    }

    public init(arbiter: OfferArbiter, world: FillWorld, clock: SurfaceClock) {
        self.arbiter = arbiter
        self.world = world
        self.clock = clock
    }

    func emit(_ command: FillCommand) { output(command) }
    func count(_ name: String) { output(.count(name)) }
    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    /// The undo grant the toast holds, while ⌘Z can take it.
    public var toastGrantID: UInt64? { toast?.grantID }
    public var toastVisible: Bool { toast != nil }
    public var isWatching: Bool { watch != nil }

    // MARK: - Helper messages

    public func receive(_ proposal: FillProposal, at uptime: UInt64) {
        status.lastProposalID = proposal.id
        status.lastProposalFields = proposal.fields.count
        status.lastProposalValues = proposal.fields.filter { $0.value != nil }.count
        let pid: Int32
        switch FillSelection.formProcess(proposal, runningBundleID: { self.world.bundleID(pid: $0) }) {
        case .refused(let reason):
            status.lastSkip = "refused.\(reason)"
            count("fill.proposalRefused.\(reason)")
            emit(.log("fill: proposal \(proposal.id) for window \(proposal.windowId) (pid \(proposal.pid), \(proposal.bundleId)) refused: \(reason)"))
            return emit(.publish)
        case .process(let p):
            pid = p
        }
        guard world.allows(pid: pid, bundleID: world.bundleID(pid: pid)) else {
            status.lastSkip = "notAllowed"
            count("fill.proposalNotAllowed")
            return emit(.publish)
        }
        held[proposal.windowId] = Held(proposal: proposal, pid: pid, receivedAt: clock.now)
        status.cachedProposals = held.count
        emit(.watchApp(pid))
        evaluate(pid: pid, trigger: .proposal(uptime))
    }

    /// The user edited, paused or forgot a memory entry (`MemoryBook.onEntryChanged`). A value from
    /// it, or resting on it as the user's identity (H1), that is up is taken down, and no proposal that
    /// came before is offered from it again.
    public func memoryChanged(id: String) {
        let now = clock.now
        memoryChangedAt = memoryChangedAt.filter { now.timeIntervalSince($0.value) <= Self.proposalMaxAge }
        memoryChangedAt[id] = now
        // Only the offer on screen needs taking down now; a held proposal is skipped when it is
        // next evaluated. Evaluating another app here could withdraw an unrelated offer.
        guard let shownOfferID, let current = arbiter.snapshot().current, current.id == shownOfferID,
              current.kind.fillOrigin?.restsOn(memory: id) == true else { return }
        evaluate(pid: current.target.pid, trigger: .other)
    }

    /// The form's app notified a focus or value change.
    public func fieldChanged(pid: Int32, at uptime: UInt64) {
        evaluate(pid: pid, trigger: .focus(uptime))
    }

    /// An app came to the front: a held proposal's app is a reason to look again, and whatever is
    /// shown is rechecked at once rather than at the next half second.
    public func appActivated(pid: Int32) {
        recheckVisibility()
        guard held.values.contains(where: { $0.pid == pid }) else { return }
        evaluate(pid: pid, trigger: .other)
    }

    /// H10: the helper said which page field the user is in, in this browser; look again there.
    public func pageFieldChanged(pid: Int32, at uptime: UInt64) {
        guard held.values.contains(where: { $0.pid == pid }) else { return }
        evaluate(pid: pid, trigger: .focus(uptime))
    }

    // MARK: - Evaluation

    func evaluate(pid: Int32, trigger: FillTrigger) {
        switch trigger {
        case .proposal: count("fill.eval.proposal")
        case .focus: count("fill.eval.focus")
        case .other: count("fill.eval.afterWrite")
        }
        let now = clock.now
        held = held.filter { now.timeIntervalSince($0.value.receivedAt) <= Self.proposalMaxAge }
        let candidates = held.values
            .filter { $0.pid == pid }
            .sorted { $0.receivedAt > $1.receivedAt }
        status.cachedProposals = held.count
        guard !candidates.isEmpty else {
            emit(.unwatchApp(pid))
            return withdraw("noProposal", pid: pid)
        }
        // A claim on its way into this app: its own write will change the field; leave the line.
        if arbiter.snapshot().insertingClaimID != nil {
            count("fill.skip.inserting")
            return emit(.publish)
        }
        // H10: a browser's page proposals are matched against the page field the helper says has focus.
        let pages = candidates.filter { PageWindow.isPage($0.proposal.windowId) }
        if !pages.isEmpty { return evaluatePage(pid: pid, candidates: pages, trigger: trigger) }
        guard let field = world.focusedField(pid: pid) else { return withdraw("fieldUnreadable", pid: pid) }
        guard world.allows(pid: pid, bundleID: field.identity.bundleID) else { return withdraw("notAllowed", pid: pid) }
        guard field.selection.isEmpty else { return withdraw("selection", pid: pid) }

        let frame = field.frame
        let focusedFrame = Frame(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
        var skip = FillSelection.Skip.noFieldAtFocus
        for candidate in candidates {
            let bound = bind(candidate.proposal.windowId, pid: pid, focused: field, focusedFrame: focusedFrame)
            let changed = Set(memoryChangedAt.filter { $0.value >= candidate.receivedAt }.keys)
            switch FillSelection.select(candidate.proposal, focusedFrame: focusedFrame, focusedValue: field.value, secure: field.secure,
                                        suppressed: suppressed, changedMemory: changed,
                                        focusedElementID: field.identity.elementID, bound: bound) {
            case .offer(let proposed, var origin):
                // A proposal the user already took a field of by Tab: the helper's Fill all rechecks
                // that every destination is still empty, so it would refuse; ⌘1 stays the app's.
                if tabbed.contains(origin.proposalID) { origin.fillAll = false }
                return present(proposed, origin: origin, field: field, trigger: trigger)
            case .skip(let reason):
                // Report the most specific reason: a matched field outranks "nothing here".
                if skip == .noFieldAtFocus { skip = reason }
            }
        }
        withdraw(skip.rawValue, pid: pid)
    }

    /// H10: the page field the user is in, matched to a proposed field by its node key, which page proposals and the
    /// helper's focus record share; the frame is where the record puts the field now, after any scroll.
    func evaluatePage(pid: Int32, candidates: [Held], trigger: FillTrigger) {
        guard let focus = world.pageFocus(pid: pid), let identity = focus.identity, let rect = focus.rect else {
            return withdraw("pageNoFocus", pid: pid)
        }
        guard world.allows(pid: pid, bundleID: focus.app.bundleId) else { return withdraw("notAllowed", pid: pid) }
        let read = FillFieldRead(identity: identity, value: focus.empty ? "" : "\u{FFFC}", selection: .caret(0), secure: false, frame: rect)
        let focusedFrame = Frame(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
        var skip = FillSelection.Skip.noFieldAtFocus
        for candidate in candidates where candidate.proposal.windowId == focus.windowId {
            let changed = Set(memoryChangedAt.filter { $0.value >= candidate.receivedAt }.keys)
            let byKey = Dictionary(uniqueKeysWithValues: candidate.proposal.fields.map { ($0.key, $0.key) })
            switch FillSelection.select(candidate.proposal, focusedFrame: focusedFrame, focusedValue: read.value, secure: false,
                                        suppressed: suppressed, changedMemory: changed, focusedElementID: identity.elementID, bound: byKey) {
            case .offer(let proposed, var origin):
                if tabbed.contains(origin.proposalID) { origin.fillAll = false }
                return present(proposed, origin: origin, field: read, trigger: trigger)
            case .skip(let reason):
                if skip == .noFieldAtFocus { skip = reason }
            }
        }
        withdraw(skip.rawValue, pid: pid)
    }

    /// Finds each proposed field's element while the form is laid out as the reader saw it, so a
    /// field focused after the page moved (a field scrolled into view, a message inserted above
    /// it) is still matched (A18, bug 12: HubSpot's Email gave `noFieldAtFocus` after a proposal
    /// made at First Name).
    ///
    /// Only while the app is in front (a background app is not read), and only while the focused
    /// field sits exactly where the proposal put one of its fields: the proposal names its window
    /// only by the reader's id, so that match is what says the focused window is the proposal's,
    /// and only elements in that window are bound. Unbound fields are tried again up to
    /// `bindAttempts` times; a field that has moved by then no longer matches its frame and stays
    /// unbound, never wrongly bound.
    func bind(_ windowID: String, pid: Int32, focused: FillFieldRead, focusedFrame: Frame) -> [String: String] {
        guard var entry = held[windowID] else { return [:] }
        var frames: [String: Frame] = [:]
        for field in entry.proposal.fields where entry.bound[field.key] == nil {
            if let frame = field.frame { frames[field.key] = frame }
        }
        guard !frames.isEmpty, entry.bindAttempts < Self.bindAttempts, world.frontmostPID == pid,
              entry.proposal.fields.contains(where: { $0.frame.map { FillSelection.matches($0, focusedFrame) } ?? false })
        else { return entry.bound }
        let found = world.elementIDs(pid: pid, at: frames, window: focused.identity.windowID)
        entry.bound.merge(found) { old, _ in old }
        entry.bindAttempts += 1
        held[windowID] = entry
        count("fill.bound.\(found.count == frames.count ? "all" : found.isEmpty ? "none" : "some")")
        return entry.bound
    }

    func present(_ proposed: FillField, origin: FillOrigin, field: FillFieldRead, trigger: FillTrigger) {
        guard let value = proposed.value else { return withdraw(FillSelection.Skip.answerNone.rawValue, pid: field.identity.pid) }
        // The frame is part of it: a field matched by its element after it moved is drawn again
        // where it is now (A18, bug 12).
        let key = [origin.proposalID, origin.fieldKey, field.identity.elementID, field.identity.elementRevision, "\(field.frame)"].joined(separator: "\u{1}")
        if key == shownKey, let shownOfferID, arbiter.snapshot().current?.id == shownOfferID { return }
        // The value is drawn in the field and the line by its top right corner: both must be
        // visible, in the frontmost app's focused field (SurfaceGate). Otherwise hold the proposal
        // and draw nothing; activation or a focus change looks again.
        let frame = field.frame
        let anchors = [CGPoint(x: frame.midX, y: frame.midY), CGPoint(x: frame.maxX - 2, y: frame.minY + 2)]
        if let hold = world.hold(for: field.identity, anchors: anchors, requireFocus: true) {
            return withdraw("held.\(hold.rawValue)", pid: field.identity.pid)
        }
        // A value whose source window has closed is not offered: Tab would only be refused
        // (SourceCheck), and "from Mail, Invoice 2041" would name a window that is gone (A14 walk-3).
        // Checked on every evaluation, not remembered: a source that opens again, or a newer proposal
        // from another source, is offered as usual.
        if sourceGone(origin) { return withdraw("sourceGone", pid: field.identity.pid) }

        let offer = Offer(
            text: value, kind: .fill(origin), target: field.identity, fieldValue: field.value,
            caretUTF16: field.selection.start, createdAt: clock.now, maxAgeSeconds: 60
        )
        guard let offerID = arbiter.publish(offer) else {
            count("fill.offerRefused")
            return emit(.publish)
        }
        shownOfferID = offerID
        shownKey = key
        lastFieldFrame = frame
        emit(.remember(offerID: offerID, bundleID: field.identity.bundleID))
        let caption = origin.sourceCaption
        let line = FillLineRule.resolve(toastSource: toast?.source, offerSource: caption)
        emit(.drawOffer(FillDraw(offerID: offerID, value: value, field: frame, caption: caption, pid: field.identity.pid, readID: field.readID, line: line, sourceApp: origin.sourceApp, fillAll: origin.fillAll)))
        if line == .replaceToast {
            // The toast gave way to an offer from another source, and its undo went with it. The
            // overlay ends the toast as it draws the new line.
            endToast(hide: nil)
        }
        count("fill.line.\(line)")
        startWatch(target: field.identity, anchors: anchors, requireFocus: true)
        emit(.offerShown(trigger))
        status.offersShown &+= 1
        status.lastSkip = nil
        emit(.publish)
    }

    /// Takes the shown offer down. `pid`: the app this evaluation was about; the offer goes only when
    /// it is in that app, so a focus change in a background app with a held proposal leaves the
    /// offer in the front app alone (CodeRabbit on PR #8). Nil takes it down wherever it is.
    func withdraw(_ reason: String, pid: Int32? = nil) {
        status.lastSkip = reason
        count("fill.skip.\(reason)")
        if let shownOfferID, pid == nil || ownsShownOffer(pid: pid!) {
            arbiter.invalidate(offerID: shownOfferID)
            emit(.hideOffer(byTyping: false))
            self.shownOfferID = nil
            shownKey = nil
        }
        emit(.publish)
    }

    /// Whether the offer on screen is in this app. True when the arbiter no longer holds it: then
    /// nothing else can be hurt by taking it down.
    func ownsShownOffer(pid: Int32) -> Bool {
        guard let shownOfferID, let current = arbiter.snapshot().current, current.id == shownOfferID else { return true }
        return current.target.pid == pid
    }

    /// A newer offer from another producer replaced the fill offer on screen.
    public func displaced(_ offer: Offer) {
        guard offer.id == shownOfferID else { return }
        emit(.hideOffer(byTyping: false))
        shownOfferID = nil
        shownKey = nil
        emit(.publish)
    }

    // MARK: - Visibility

    /// Whatever fill surface is shown (the offer, then its toast) is rechecked every half second
    /// and taken down when the form is no longer where the user is looking.
    func startWatch(target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) {
        stopWatch()
        let timer = clock.schedule(after: Self.recheckInterval, repeats: true) { [weak self] in self?.recheckVisibility() }
        watch = Watch(target: target, anchors: anchors, requireFocus: requireFocus, timer: timer)
    }

    func stopWatch() {
        watch?.timer.cancel()
        watch = nil
    }

    /// The source a value was taken from is known to be gone. Unknown is not gone: SourceCheck still
    /// rechecks the value before the write.
    func sourceGone(_ origin: FillOrigin) -> Bool {
        guard case .window(let w) = origin.source else { return false }
        return world.sourceOpen(w) == false
    }

    public func recheckVisibility() {
        // The offer on screen is withdrawn as soon as its source window closes, not at Tab. The
        // toast after a write stays: its undo needs only the field written.
        if let shownOfferID, let current = arbiter.snapshot().current, current.id == shownOfferID,
           let origin = current.kind.fillOrigin, sourceGone(origin) {
            count("fill.withdrawn.sourceGone")
            withdraw("sourceGone")
            if toast == nil { stopWatch() }
            return
        }
        guard let watch, let hold = world.hold(for: watch.target, anchors: watch.anchors, requireFocus: watch.requireFocus) else { return }
        stopWatch()
        count("fill.withdrawn.\(hold.rawValue)")
        withdraw("held.\(hold.rawValue)")
        endToast(hide: nil)
        emit(.hideAll)
        emit(.publish)
    }

    // MARK: - Keys (the tap thread's decisions, on main)

    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        let snapshot = arbiter.snapshot()
        if let shownOfferID, snapshot.current?.id != shownOfferID {
            emit(.hideOffer(byTyping: reason == .dismissed || reason == .typedThrough))
            self.shownOfferID = nil
            shownKey = nil
        }
        syncToast(snapshot, byTyping: reason != .toastDismissed && reason != .closed)
        emit(.publish)
    }

    public func claimed(_ claim: Claim) {
        syncToast(arbiter.snapshot(), byTyping: false)
        guard case .fill(let origin) = claim.offer.kind, claim.offer.id == shownOfferID else { return emit(.publish) }
        if claim.choice.fillAll {
            // ⌘1: the helper fills the form in one run (D2-04) and reports it as a task under the
            // proposal's id. H10: this machine shows its result, with ⌘Z, as it does a Tab's.
            emit(.fillAll(origin.proposalID))
            helperFills[origin.proposalID] = HelperFill(origin: origin, target: claim.offer.target, field: lastFieldFrame, oneField: false, value: claim.offer.text)
            emit(.hideOffer(byTyping: false))
            emit(.count("fill.fillAll"))
            shownOfferID = nil
            shownKey = nil
            return emit(.publish)
        }
        if PageWindow.isPage(origin.windowID) {
            // H10: a page field is the helper's to write (Claim.insertsText is false here); its result
            // comes back as the task's progress (`taskProgress`).
            emit(.fillField(proposalID: origin.proposalID, fieldKey: origin.fieldKey))
            helperFills[FillAllRequest.fieldTask(proposalId: origin.proposalID, fieldKey: origin.fieldKey)] = HelperFill(origin: origin, target: claim.offer.target, field: lastFieldFrame, oneField: true, value: claim.offer.text)
            tabbed.insert(origin.proposalID)
            emit(.count("fill.pageField"))
        }
        emit(.markWorking)
        shownOfferID = nil
        shownKey = nil
        emit(.publish)
    }

    /// ⌘Z took the grant; the executor is already reverting. The toast stays up until its time.
    /// H10: for a fill the helper ran (`ownsTask`), the helper reverts it: the undo is sent here.
    public func undoStarted(_ grant: UndoGrant) {
        if let taskID = grant.taskID {
            guard ownsTask(taskID) else { return }
            emit(.undoTask(taskID))
            count("fill.helperFill.undo")
        }
        toast?.grantID = nil
        status.toast?.grantID = nil
        emit(.publish)
    }

    // MARK: - Fills the helper runs (H10)

    /// Whether this machine asked for the run `taskID` (Tab on a page field, or ⌘1), so it shows the run's result and
    /// its ⌘Z goes here.
    public func ownsTask(_ taskID: String) -> Bool { helperFills[taskID] != nil }

    /// The helper's progress on a fill it runs for this machine. The run's end is the toast a Tab's write gets:
    /// "Filled 1 field from TextEdit" with ⌘Z, or why nothing was filled; its undo's end says what was cleared.
    public func taskProgress(_ progress: TaskProgress) {
        guard let fill = helperFills[progress.taskId] else { return }
        let origin = fill.origin
        let pid = fill.target.pid
        func fields(_ n: Int) -> String { n == 1 ? "1 field" : "\(n) fields" }
        switch progress.phase {
        case .done:
            let written = progress.written ?? 0
            // A Tab's one field is reported as a native Tab's is (the helper records the use and marks the write as
            // Caret's); ⌘1's run is the helper's own task and was never reported per field (D2-04).
            if fill.oneField {
                report(FillResult(
                    at: nowMs, proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey,
                    outcome: written > 0 ? .inserted : .failed, reason: written > 0 ? nil : "nothingWritten", method: nil,
                    valueLength: written > 0 ? UTF16Text.length(fill.value) : 0
                ))
            }
            guard written > 0 else { return failHelperFill(fill, progress.taskId, caption: Self.errorCaption(nil)) }
            let grant = UndoGrant.task(progress.taskId, target: fill.target, createdAt: clock.now)
            let id = arbiter.showToast(grant)
            let caption = "\(fields(written)) \(origin.toastSource)"
            if let frame = fill.field {
                startWatch(target: fill.target, anchors: [CGPoint(x: frame.maxX - 2, y: frame.minY + 2)], requireFocus: false)
            }
            showToast(
                FillToastDraw(kind: .done, lead: "Filled", text: caption, keycap: Hint(key: "⌘Z", label: "Undo"), field: fill.field, pid: pid, source: origin.sourceCaption),
                lifetime: grant.lifetimeSeconds, grantID: id, info: DebugState.Toast(kind: "done", caption: "Filled \(caption)", grantID: id)
            )
            emit(.toastSlotTaken)
            count("fill.helperFill.done")
            // The page moves focus on only when the user does; look again soon in case the record lags the write.
            rereads[pid]?.cancel()
            rereads[pid] = clock.schedule(after: Self.rereadAfterWrite, repeats: false) { [weak self] in
                self?.rereads[pid] = nil
                self?.evaluate(pid: pid, trigger: .other)
            }
        case .stopped, .paused:
            failHelperFill(fill, progress.taskId, caption: Self.stopCaption(progress.phase == .paused ? .you : progress.stopReason))
        case .undone:
            helperFills[progress.taskId] = nil
            let n = progress.restored ?? 0
            let ok = n > 0 && (progress.notRestored ?? 0) == 0
            if ok, fill.oneField {
                suppressed.insert(FillSelection.suppressionKey(windowID: origin.windowID, fieldKey: origin.fieldKey, value: fill.value))
                report(FillResult(at: nowMs, proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey, outcome: .undone, reason: nil, method: nil, valueLength: 0))
            }
            let caption = ok ? "Cleared \(fields(n))" : "The field changed after the fill, so it was left as it is."
            let kind: FillToastDraw.Kind = ok ? .undone : .error
            showToast(
                FillToastDraw(kind: kind, lead: nil, text: caption, keycap: nil, field: fill.field, pid: pid, source: origin.sourceCaption),
                lifetime: ok ? Self.undoneLifetime : Self.errorLifetime, grantID: nil,
                info: DebugState.Toast(kind: kind.rawValue, caption: caption, grantID: nil)
            )
            count("fill.helperFill.undone")
        case .started, .skipped, .acting, .verified, .handoff:
            break
        }
        emit(.publish)
    }

    /// The request for `taskID` could not be sent; no progress will come for it.
    public func helperFillUnsent(_ taskID: String) {
        guard let fill = helperFills[taskID] else { return }
        failHelperFill(fill, taskID, caption: Self.errorCaption(nil))
        emit(.publish)
    }

    func failHelperFill(_ fill: HelperFill, _ taskID: String, caption: String) {
        helperFills[taskID] = nil
        if fill.oneField { suppressed.insert(FillSelection.suppressionKey(windowID: fill.origin.windowID, fieldKey: fill.origin.fieldKey, value: fill.value)) }
        showToast(
            FillToastDraw(kind: .error, lead: nil, text: caption, keycap: nil, field: fill.field, pid: fill.target.pid, source: fill.origin.sourceCaption),
            lifetime: Self.errorLifetime, grantID: nil, info: DebugState.Toast(kind: "error", caption: caption, grantID: nil)
        )
        count("fill.helperFill.failed")
    }

    /// Why a fill the helper ran stopped, in the toast's words.
    public static func stopCaption(_ reason: TaskProgress.StopReason?) -> String {
        switch reason {
        case .you?: return "Caret stopped when you typed, so the rest is yours."
        case .changed?, .mismatch?: return errorCaption("fieldContentChanged")
        case .windowGone?, .readerRestarted?: return "The page changed, so nothing was filled."
        default: return errorCaption(nil)
        }
    }

    /// Another owner's toast took the arbiter's toast slot: this one's toast, if any, is gone.
    public func toastChanged() {
        syncToast(arbiter.snapshot(), byTyping: false)
        emit(.publish)
    }

    func syncToast(_ snapshot: OfferArbiter.Snapshot, byTyping: Bool) {
        guard let grant = toast?.grantID, snapshot.toast?.id != grant else { return }
        endToast(hide: byTyping)
    }

    // MARK: - Results

    public func insertionFinished(_ result: FillInsertion) {
        guard let origin = result.claim.offer.kind.fillOrigin else { return }
        let pid = result.claim.offer.target.pid
        if !result.verified {
            suppressed.insert(FillSelection.suppressionKey(windowID: origin.windowID, fieldKey: origin.fieldKey, value: result.claim.offer.text))
        }
        let outcome: FillResult.Outcome = result.rejected ? .rejected : (result.verified ? .inserted : .failed)
        report(FillResult(
            at: nowMs, proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey,
            outcome: outcome, reason: result.verified ? nil : result.reason, method: result.rejected ? nil : result.method,
            valueLength: result.verified ? result.insertedLength : 0
        ))

        if !result.rejected { tabbed.insert(origin.proposalID) }
        if result.verified {
            // A verified write with no undo grant still filled the field: it says so, with no ⌘Z
            // (CodeRabbit on PR #8: it said "Nothing was filled.").
            let grant = result.undo
            if let frame = lastFieldFrame {
                // The form has usually moved focus on; the toast reports on work, not on a field.
                startWatch(target: grant?.target ?? result.claim.offer.target, anchors: [CGPoint(x: frame.maxX - 2, y: frame.minY + 2)], requireFocus: false)
            }
            let id = grant.map { arbiter.showToast($0) }
            // The toast names the app only ("Filled 4 fields from Mail", SURFACES.md section 6);
            // the offer line already named the window.
            let caption = "1 field \(origin.toastSource)"
            showToast(
                FillToastDraw(kind: .done, lead: "Filled", text: caption, keycap: grant == nil ? nil : Hint(key: "⌘Z", label: "Undo"), field: lastFieldFrame, pid: pid, source: origin.sourceCaption),
                lifetime: grant?.lifetimeSeconds ?? UndoGrant.defaultLifetime, grantID: id,
                info: DebugState.Toast(kind: "done", caption: "Filled \(caption)", grantID: id)
            )
            // On screen either way, so a pop-up's toast gives way to it.
            emit(.toastSlotTaken)
        } else if let grant = result.undo, let recovery = result.recovery {
            // S2: Caret could not confirm the write, and the field holds the whole value or only part
            // of it. The toast says so and owns ⌘Z, which takes Caret's characters out.
            let id = arbiter.showToast(grant)
            let caption = Self.unconfirmedCaption(recovery)
            showToast(
                FillToastDraw(kind: .error, lead: nil, text: caption, keycap: Hint(key: "⌘Z", label: "Undo"), field: lastFieldFrame, pid: pid, source: origin.sourceCaption),
                lifetime: grant.lifetimeSeconds, grantID: id, info: DebugState.Toast(kind: "error", caption: caption, grantID: id)
            )
            emit(.toastSlotTaken)
        } else {
            let caption = result.recovery?.says.map(Self.sentence) ?? Self.errorCaption(result.reason, field: result.strayField)
            showToast(
                FillToastDraw(kind: .error, lead: nil, text: caption, keycap: nil, field: lastFieldFrame, pid: pid, source: origin.sourceCaption),
                lifetime: Self.errorLifetime, grantID: nil, info: DebugState.Toast(kind: "error", caption: caption, grantID: nil)
            )
        }
        // A verified fill moves focus on; the watcher reports it, but read again soon in case the
        // app posts nothing for a programmatic focus change.
        rereads[pid]?.cancel()
        rereads[pid] = clock.schedule(after: Self.rereadAfterWrite, repeats: false) { [weak self] in
            self?.rereads[pid] = nil
            self?.evaluate(pid: pid, trigger: .other)
        }
        emit(.publish)
    }

    public func undoFinished(_ result: FillUndo) {
        guard let origin = result.grant.origin else { return }
        let pid = result.grant.target.pid
        if result.ok {
            suppressed.insert(FillSelection.suppressionKey(windowID: origin.windowID, fieldKey: origin.fieldKey, value: result.grant.writtenValue))
        }
        report(FillResult(
            at: nowMs, proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey,
            outcome: result.ok ? .undone : .undoFailed, reason: result.error, method: .axValue,
            valueLength: result.ok ? 0 : UTF16Text.length(result.grant.writtenValue)
        ))
        let caption: String
        switch (result.ok, result.error) {
        case (true, _): caption = result.partial ? "Took out the part that went in" : "Cleared 1 field"
        case (false, UndoGuard.Rejection.nothingWritten.code?): caption = "The field already reads as it did before the fill."
        default: caption = result.says.map(Self.sentence) ?? "The field changed after the fill, so it was left as it is."
        }
        let kind: FillToastDraw.Kind = result.ok ? .undone : .error
        showToast(
            FillToastDraw(kind: kind, lead: nil, text: caption, keycap: nil, field: lastFieldFrame, pid: pid, source: origin.sourceCaption),
            lifetime: result.ok ? Self.undoneLifetime : Self.errorLifetime, grantID: nil,
            info: DebugState.Toast(kind: kind.rawValue, caption: caption, grantID: nil)
        )
        emit(.publish)
    }

    /// Draws a toast in place of whatever line is up. A toast it replaces takes its ⌘Z with it:
    /// ⌘Z belongs to a write only while that write's toast is on screen.
    func showToast(_ draw: FillToastDraw, lifetime: TimeInterval, grantID: UInt64?, info: DebugState.Toast) {
        if let old = toast {
            old.timer.cancel()
            if let oldGrant = old.grantID, oldGrant != grantID { arbiter.dismissToast(grantID: oldGrant) }
        }
        let timer = clock.schedule(after: lifetime, repeats: false) { [weak self] in
            guard let self else { return }
            self.endToast(hide: false)
            self.emit(.publish)
        }
        toast = Toast(source: draw.source, grantID: grantID, timer: timer)
        status.toast = info
        emit(.drawToast(draw))
    }

    /// Ends the toast and its grant. `hide` nil: the overlay already took it down.
    func endToast(hide byTyping: Bool?) {
        guard let current = toast else { return }
        current.timer.cancel()
        if let grant = current.grantID { arbiter.dismissToast(grantID: grant) }
        toast = nil
        status.toast = nil
        if let byTyping { emit(.hideToast(byTyping: byTyping)) }
    }

    /// The settings closed the gate (pause, or the fill role off): the offer goes and every held
    /// proposal is dropped, so no later focus change can bring one back. The helper proposes again
    /// once the gate opens. A toast already up stays: it reports a write that happened.
    public func gateClosed() {
        for pid in Set(held.values.map(\.pid)) { emit(.unwatchApp(pid)) }
        held = [:]
        status.cachedProposals = 0
        withdraw("gateClosed")
    }

    public func shutdown() {
        stopWatch()
        for timer in rereads.values { timer.cancel() }
        rereads = [:]
        toast?.timer.cancel()
        toast = nil
        emit(.hideAll)
        arbiter.invalidate(kind: "fill")
    }

    func report(_ result: FillResult) {
        status.lastResult = result
        emit(.send(result))
    }

    /// A fill Caret could not confirm, whose field it recognizes (S2). Only `whole` and `partial`
    /// leave a grant.
    public static func unconfirmedCaption(_ recovery: UnconfirmedInsert.Report) -> String {
        if case .partial = recovery.state { return "Only part of the value went in." }
        return "Caret couldn't confirm the fill, but the field holds it."
    }

    /// A clause of S1's wording as a toast's sentence.
    static func sentence(_ clause: String) -> String {
        clause.prefix(1).uppercased() + clause.dropFirst() + "."
    }

    /// What went wrong and what next, without blame or probabilities (`IDENTITY.md` captions).
    public static func errorCaption(_ reason: String?, field: String? = nil) -> String {
        switch reason ?? "" {
        // The paste went to the field that took focus as it was sent (S1 audit #13).
        case "wroteElsewhere":
            return "It may have gone into \(field ?? "another field") instead. Check that field."
        case "revoked":
            return "Caret stopped before filling, so nothing was filled."
        case let r where r.hasPrefix("source."):
            return "The source changed, so nothing was filled."
        case "targetMoved", "fieldContentChanged", "selectionMoved", "replacedTextChanged":
            return "The field changed, so nothing was filled."
        case "offerExpired":
            return "That suggestion was too old, so nothing was filled."
        case "writeIgnored", "writeMismatch":
            return "The field didn't take the value. Type it in to fill it."
        // This app only takes a paste, and what is on the clipboard could not be put back exactly
        // (`WriteFallback.clipboardUnrestorable`).
        case WriteFallback.clipboardUnrestorable:
            return "Pasting here would change what you copied, so nothing was filled. Type it in to fill it."
        default:
            return "Nothing was filled."
        }
    }
}
