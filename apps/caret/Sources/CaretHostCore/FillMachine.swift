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
    func bundleID(pid: Int32) -> String?
    /// The app's focused field. Nil when it cannot be read or reports no frame.
    func focusedField(pid: Int32) -> FillFieldRead?
    /// `Visibility.hold`: nil when a surface for `target` may be drawn at `anchors`.
    func hold(for target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) -> SurfaceGate.Hold?
    /// Whether a fill's source window is still open: its app runs and has a window with that title.
    /// Nil when the source names no process to look in. Cheap: one app's window titles, no walk.
    func sourceOpen(_ source: FillOrigin.Window) -> Bool?
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
    /// For a verified fill: what ⌘Z may revert while the toast is up.
    public var undo: UndoGrant?
    public var insertedLength: Int
    /// The field a paste landed in instead, by its label (`wroteElsewhere`).
    public var strayField: String?

    public init(claim: Claim, verified: Bool, rejected: Bool, reason: String?, method: FillResult.Method?, undo: UndoGrant?, insertedLength: Int, strayField: String? = nil) {
        self.claim = claim
        self.verified = verified
        self.rejected = rejected
        self.reason = reason
        self.method = method
        self.undo = undo
        self.insertedLength = insertedLength
        self.strayField = strayField
    }
}

/// What became of ⌘Z on a fill's toast.
public struct FillUndo: Equatable, Sendable {
    public var grant: UndoGrant
    public var ok: Bool
    public var error: String?

    public init(grant: UndoGrant, ok: Bool, error: String?) {
        self.grant = grant
        self.ok = ok
        self.error = error
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
        let receivedAt: Date
    }

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
    /// When each memory entry was last edited, paused or forgotten. The helper cannot take back one
    /// field of a proposal it sent, so a held proposal's value from an entry changed after it
    /// arrived is skipped here; entries older than `proposalMaxAge` are dropped with the proposals.
    var memoryChangedAt: [String: Date] = [:]
    var toast: Toast?
    var watch: Watch?
    /// The read after a write, per app.
    var rereads: [Int32: SurfaceTimer] = [:]

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
        guard let pid = FillSelection.pid(fromWindowID: proposal.windowId), world.allows(pid: pid, bundleID: world.bundleID(pid: pid)) else {
            status.lastSkip = "notAllowed"
            count("fill.proposalNotAllowed")
            return emit(.publish)
        }
        held[proposal.windowId] = Held(proposal: proposal, receivedAt: clock.now)
        status.cachedProposals = held.count
        emit(.watchApp(pid))
        evaluate(pid: pid, trigger: .proposal(uptime))
    }

    /// The user edited, paused or forgot a memory entry (`MemoryBook.onEntryChanged`). A value from
    /// it that is up is taken down, and no proposal that came before is offered from it again.
    public func memoryChanged(id: String) {
        let now = clock.now
        memoryChangedAt = memoryChangedAt.filter { now.timeIntervalSince($0.value) <= Self.proposalMaxAge }
        memoryChangedAt[id] = now
        // Only the offer on screen needs taking down now; a held proposal is skipped when it is
        // next evaluated. Evaluating another app here could withdraw an unrelated offer.
        guard let shownOfferID, let current = arbiter.snapshot().current, current.id == shownOfferID,
              current.kind.fillOrigin?.memoryID == id else { return }
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
        guard held.values.contains(where: { FillSelection.pid(fromWindowID: $0.proposal.windowId) == pid }) else { return }
        evaluate(pid: pid, trigger: .other)
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
            .filter { FillSelection.pid(fromWindowID: $0.proposal.windowId) == pid }
            .sorted { $0.receivedAt > $1.receivedAt }
        status.cachedProposals = held.count
        guard !candidates.isEmpty else {
            emit(.unwatchApp(pid))
            return withdraw("noProposal")
        }
        // A claim on its way into this app: its own write will change the field; leave the line.
        if arbiter.snapshot().insertingClaimID != nil {
            count("fill.skip.inserting")
            return emit(.publish)
        }
        guard let field = world.focusedField(pid: pid) else { return withdraw("fieldUnreadable") }
        guard world.allows(pid: pid, bundleID: field.identity.bundleID) else { return withdraw("notAllowed") }
        guard field.selection.isEmpty else { return withdraw("selection") }

        let frame = field.frame
        let focusedFrame = Frame(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
        var skip = FillSelection.Skip.noFieldAtFocus
        for candidate in candidates {
            let changed = Set(memoryChangedAt.filter { $0.value >= candidate.receivedAt }.keys)
            switch FillSelection.select(candidate.proposal, focusedFrame: focusedFrame, focusedValue: field.value, secure: field.secure,
                                        suppressed: suppressed, changedMemory: changed) {
            case .offer(let proposed, let origin):
                return present(proposed, origin: origin, field: field, trigger: trigger)
            case .skip(let reason):
                // Report the most specific reason: a matched field outranks "nothing here".
                if skip == .noFieldAtFocus { skip = reason }
            }
        }
        withdraw(skip.rawValue)
    }

    func present(_ proposed: FillField, origin: FillOrigin, field: FillFieldRead, trigger: FillTrigger) {
        guard let value = proposed.value else { return withdraw(FillSelection.Skip.answerNone.rawValue) }
        let key = [origin.proposalID, origin.fieldKey, field.identity.elementID, field.identity.elementRevision].joined(separator: "\u{1}")
        if key == shownKey, let shownOfferID, arbiter.snapshot().current?.id == shownOfferID { return }
        // The value is drawn in the field and the line by its top right corner: both must be
        // visible, in the frontmost app's focused field (SurfaceGate). Otherwise hold the proposal
        // and draw nothing; activation or a focus change looks again.
        let frame = field.frame
        let anchors = [CGPoint(x: frame.midX, y: frame.midY), CGPoint(x: frame.maxX - 2, y: frame.minY + 2)]
        if let hold = world.hold(for: field.identity, anchors: anchors, requireFocus: true) {
            return withdraw("held.\(hold.rawValue)")
        }
        // A value whose source window has closed is not offered: Tab would only be refused
        // (SourceCheck), and "from Mail, Invoice 2041" would name a window that is gone (A14 walk-3).
        // Checked on every evaluation, not remembered: a source that opens again, or a newer proposal
        // from another source, is offered as usual.
        if sourceGone(origin) { return withdraw("sourceGone") }

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
        emit(.drawOffer(FillDraw(offerID: offerID, value: value, field: frame, caption: caption, pid: field.identity.pid, readID: field.readID, line: line)))
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

    func withdraw(_ reason: String) {
        status.lastSkip = reason
        count("fill.skip.\(reason)")
        if let shownOfferID {
            arbiter.invalidate(offerID: shownOfferID)
            emit(.hideOffer(byTyping: false))
            self.shownOfferID = nil
            shownKey = nil
        }
        emit(.publish)
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
        guard case .fill = claim.offer.kind, claim.offer.id == shownOfferID else { return emit(.publish) }
        emit(.markWorking)
        shownOfferID = nil
        shownKey = nil
        emit(.publish)
    }

    /// ⌘Z took the grant; the executor is already reverting. The toast stays up until its time.
    public func undoStarted(_ grant: UndoGrant) {
        guard grant.taskID == nil else { return }
        toast?.grantID = nil
        status.toast?.grantID = nil
        emit(.publish)
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

        if result.verified, let grant = result.undo {
            if let frame = lastFieldFrame {
                // The form has usually moved focus on; the toast reports on work, not on a field.
                startWatch(target: grant.target, anchors: [CGPoint(x: frame.maxX - 2, y: frame.minY + 2)], requireFocus: false)
            }
            let id = arbiter.showToast(grant)
            // The toast names the app only ("Filled 4 fields from Mail", SURFACES.md section 6);
            // the offer line already named the window.
            let caption = "1 field \(origin.toastSource)"
            showToast(
                FillToastDraw(kind: .done, lead: "Filled", text: caption, keycap: Hint(key: "⌘Z", label: "Undo"), field: lastFieldFrame, pid: pid, source: origin.sourceCaption),
                lifetime: grant.lifetimeSeconds, grantID: id,
                info: DebugState.Toast(kind: "done", caption: "Filled \(caption)", grantID: id)
            )
            emit(.toastSlotTaken)
        } else {
            let caption = Self.errorCaption(result.reason, field: result.strayField)
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
        let caption = result.ok ? "Cleared 1 field" : "The field changed after the fill, so it was left as it is."
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
        for pid in Set(held.values.compactMap { FillSelection.pid(fromWindowID: $0.proposal.windowId) }) { emit(.unwatchApp(pid)) }
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

    /// What went wrong and what next, without blame or probabilities (`IDENTITY.md` captions).
    public static func errorCaption(_ reason: String?, field: String? = nil) -> String {
        switch reason ?? "" {
        // The paste went to the field that took focus as it was sent (S1 audit #13).
        case "wroteElsewhereRepaired":
            return "It went into \(field ?? "another field") instead, so Caret took it back out. Nothing was filled."
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
        default:
            return "Nothing was filled."
        }
    }
}
