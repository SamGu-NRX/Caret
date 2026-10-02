import AppKit
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import Foundation

/// Main-thread orchestration of grounded fill: helper proposals and form focus in; fill offers,
/// the overlay, results to the helper and the undo toast out.
///
/// The helper proposes once per form (one entry per empty field) and then stays quiet for that
/// form for 30 s, so the coordinator keeps the latest proposal per window and re-evaluates it on
/// every focus or value change in the form's app. The invariant matches `HostCoordinator`'s: a
/// fill value is on screen exactly when the arbiter holds the fill offer it was drawn for.
@MainActor
final class FillCoordinator {
    private struct Held {
        let proposal: FillProposal
        let receivedAt: Date
    }

    private enum Trigger {
        /// A proposal arrived at this uptime.
        case proposal(UInt64)
        /// The form's app notified at this uptime.
        case focus(UInt64)
        case other
    }

    /// A held proposal is used for at most this long. Assumed: the helper re-proposes a form after
    /// 30 s of quiet, and its values are rechecked against the source before every write anyway.
    private let proposalMaxAge: TimeInterval = 120

    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let overlay: FillOverlay
    private let watcher: FillTargetWatcher
    private let policy: TargetPolicy
    var executor: InsertionExecutor?
    var client: HelperClient?

    private var held: [String: Held] = [:]
    private var shownOfferID: UInt64?
    /// What the shown offer is for, so a repeat evaluation of the same state does not republish.
    private var shownKey: String?
    private var lastFieldFrame: CGRect?
    private var toastGrantID: UInt64?
    /// Values refused or undone, per field (`FillSelection.suppressionKey`).
    private var suppressed: Set<String> = []
    private var toastGrantTimer: Timer?

    init(arbiter: OfferArbiter, status: HostStatus, overlay: FillOverlay, watcher: FillTargetWatcher, policy: TargetPolicy) {
        self.arbiter = arbiter
        self.status = status
        self.overlay = overlay
        self.watcher = watcher
        self.policy = policy
        watcher.onChange = { [weak self] pid, at in self?.evaluate(pid: pid, trigger: .focus(at)) }
        overlay.onChange = { [weak self, weak overlay] in
            guard let self, let overlay else { return }
            let info = overlay.debugInfo()
            self.status.update { $0.fill.overlay = info }
        }
    }

    // MARK: - Helper messages

    func receive(_ message: HelperInbound, at uptime: UInt64) {
        guard case .fillProposal(let proposal) = message else { return }
        status.update { s in
            s.fill.lastProposalID = proposal.id
            s.fill.lastProposalFields = proposal.fields.count
            s.fill.lastProposalValues = proposal.fields.filter { $0.value != nil }.count
        }
        guard let pid = FillSelection.pid(fromWindowID: proposal.windowId),
              policy.allows(pid: pid, bundleID: NSRunningApplicationBundle.id(of: pid))
        else {
            status.update { $0.fill.lastSkip = "notAllowed" }
            return status.increment("fill.proposalNotAllowed")
        }
        held[proposal.windowId] = Held(proposal: proposal, receivedAt: Date())
        status.update { $0.fill.cachedProposals = self.held.count }
        watcher.watch(pid)
        evaluate(pid: pid, trigger: .proposal(uptime))
    }

    // MARK: - Evaluation

    private func evaluate(pid: pid_t, trigger: Trigger) {
        switch trigger {
        case .proposal: status.increment("fill.eval.proposal")
        case .focus: status.increment("fill.eval.focus")
        case .other: status.increment("fill.eval.afterWrite")
        }
        let now = Date()
        held = held.filter { now.timeIntervalSince($0.value.receivedAt) <= proposalMaxAge }
        let candidates = held.values
            .filter { FillSelection.pid(fromWindowID: $0.proposal.windowId) == pid }
            .sorted { $0.receivedAt > $1.receivedAt }
        status.update { $0.fill.cachedProposals = self.held.count }
        guard !candidates.isEmpty else {
            watcher.unwatch(pid)
            return withdraw("noProposal")
        }
        // A claim on its way into this app: its own write will change the field; leave the line.
        if arbiter.snapshot().insertingClaimID != nil {
            return status.increment("fill.skip.inserting")
        }

        guard let reread = FieldReader.readFocused(pid: pid), let frame = AXRead.frame(of: reread.element) else {
            return withdraw("fieldUnreadable")
        }
        let (element, field) = reread
        guard policy.allows(pid: pid, bundleID: field.identity.bundleID) else { return withdraw("notAllowed") }
        guard field.selection.isEmpty else { return withdraw("selection") }

        let focusedFrame = Frame(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
        var skip = FillSelection.Skip.noFieldAtFocus
        for candidate in candidates {
            switch FillSelection.select(candidate.proposal, focusedFrame: focusedFrame, focusedValue: field.value, secure: field.secure, suppressed: suppressed) {
            case .offer(let proposed, let origin):
                return present(proposed, origin: origin, element: element, field: field, frame: frame, trigger: trigger)
            case .skip(let reason):
                // Report the most specific reason: a matched field outranks "nothing here".
                if skip == .noFieldAtFocus { skip = reason }
            }
        }
        withdraw(skip.rawValue)
    }

    private func present(_ proposed: FillField, origin: FillOrigin, element: AXUIElement, field: FieldState, frame: CGRect, trigger: Trigger) {
        guard let value = proposed.value else { return withdraw(FillSelection.Skip.answerNone.rawValue) }
        let key = [origin.proposalID, origin.fieldKey, field.identity.elementID, field.identity.elementRevision].joined(separator: "\u{1}")
        if key == shownKey, let shownOfferID, arbiter.snapshot().current?.id == shownOfferID { return }

        let offer = Offer(
            text: value, kind: .fill(origin), target: field.identity, fieldValue: field.value,
            caretUTF16: field.selection.start, maxAgeSeconds: 60
        )
        guard let offerID = arbiter.publish(offer) else {
            status.increment("fill.offerRefused")
            return
        }
        shownOfferID = offerID
        shownKey = key
        lastFieldFrame = frame
        executor?.remember(offerID: offerID, context: TextFieldContext(
            beforeCursor: "", target: AppTarget(bundleIdentifier: field.identity.bundleID, appName: "")
        ))
        overlay.showOffer(value: value, fieldFrame: frame, style: FieldStyleProbe.style(of: element), caption: origin.sourceCaption)

        let elapsedMs: (UInt64) -> Double = { Double(DispatchTime.now().uptimeNanoseconds &- $0) / 1_000_000 }
        switch trigger {
        case .proposal(let at): status.proposalToOffer.record(elapsedMs(at))
        case .focus(let at): status.focusToOffer.record(elapsedMs(at))
        case .other: break
        }
        status.update { s in
            s.fill.offersShown &+= 1
            s.fill.lastSkip = nil
        }
    }

    private func withdraw(_ reason: String) {
        status.update { $0.fill.lastSkip = reason }
        status.increment("fill.skip.\(reason)")
        guard let shownOfferID else { return }
        arbiter.invalidate(offerID: shownOfferID)
        overlay.hideOffer(byTyping: false)
        self.shownOfferID = nil
        shownKey = nil
    }

    // MARK: - Keys (posted to main by the tap thread)

    func offerChanged(_ reason: OfferArbiter.PassReason) {
        let snapshot = arbiter.snapshot()
        if let shownOfferID, snapshot.current?.id != shownOfferID {
            overlay.hideOffer(byTyping: reason == .dismissed || reason == .typedThrough)
            self.shownOfferID = nil
            shownKey = nil
        }
        syncToast(snapshot, byTyping: reason != .toastDismissed && reason != .closed)
    }

    func claimed(_ claim: Claim) {
        syncToast(arbiter.snapshot(), byTyping: false)
        guard case .fill = claim.offer.kind, claim.offer.id == shownOfferID else { return }
        overlay.markWorking()
        shownOfferID = nil
        shownKey = nil
    }

    /// ⌘Z took the grant; the executor is already reverting.
    func undoStarted(_ grant: UndoGrant) {
        toastGrantTimer?.invalidate()
        toastGrantID = nil
        status.update { $0.fill.toast?.grantID = nil }
    }

    private func syncToast(_ snapshot: OfferArbiter.Snapshot, byTyping: Bool) {
        guard let toastGrantID, snapshot.toast?.id != toastGrantID else { return }
        self.toastGrantID = nil
        toastGrantTimer?.invalidate()
        overlay.hideToast(byTyping: byTyping)
        status.update { $0.fill.toast = nil }
    }

    // MARK: - Results

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard let origin = result.claim.offer.kind.fillOrigin else { return }
        let pid = result.claim.offer.target.pid
        let verified = result.insertion.verified == true
        if !verified {
            suppressed.insert(FillSelection.suppressionKey(windowID: origin.windowID, fieldKey: origin.fieldKey, value: result.claim.offer.text))
        }
        let outcome: FillResult.Outcome = result.rejected ? .rejected : (verified ? .inserted : .failed)
        report(FillResult(
            at: Self.nowMs(), proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey,
            outcome: outcome, reason: verified ? nil : result.reason, method: result.rejected ? nil : result.method,
            valueLength: verified ? UTF16Text.length(result.claim.insertionText) : 0
        ))

        if verified, let grant = result.undo {
            let id = arbiter.showToast(grant)
            toastGrantID = id
            // The toast names the app only ("Filled 4 fields from Mail", SURFACES.md section 6); the
            // offer line already named the window.
            let caption = "1 field from \(origin.sourceAppName)"
            overlay.showToast(.done, lead: "Filled", text: caption, keycap: "⌘Z Undo", lifetime: grant.lifetimeSeconds, anchor: lastFieldFrame)
            status.update { $0.fill.toast = DebugState.Toast(kind: "done", caption: "Filled \(caption)", grantID: id) }
            toastGrantTimer?.invalidate()
            toastGrantTimer = Timer.scheduledTimer(withTimeInterval: grant.lifetimeSeconds, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.toastGrantID == id else { return }
                    self.arbiter.dismissToast(grantID: id)
                    self.toastGrantID = nil
                    self.status.update { $0.fill.toast = nil }
                }
            }
        } else {
            let caption = Self.errorCaption(result.reason)
            overlay.showToast(.error, lead: nil, text: caption, keycap: nil, lifetime: 6, anchor: lastFieldFrame)
            status.update { $0.fill.toast = DebugState.Toast(kind: "error", caption: caption, grantID: nil) }
        }
        // A verified fill moves focus on; the watcher reports it, but re-read now in case the app
        // posts nothing for a programmatic focus change.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            MainActor.assumeIsolated { self?.evaluate(pid: pid, trigger: .other) }
        }
    }

    func undoFinished(_ result: InsertionExecutor.UndoResult) {
        guard let origin = result.grant.origin else { return }
        if result.ok {
            suppressed.insert(FillSelection.suppressionKey(windowID: origin.windowID, fieldKey: origin.fieldKey, value: result.grant.writtenValue))
        }
        report(FillResult(
            at: Self.nowMs(), proposalId: origin.proposalID, windowId: origin.windowID, fieldKey: origin.fieldKey,
            outcome: result.ok ? .undone : .undoFailed, reason: result.error, method: .axValue,
            valueLength: result.ok ? 0 : UTF16Text.length(result.grant.writtenValue)
        ))
        if result.ok {
            overlay.showToast(.undone, lead: nil, text: "Cleared 1 field", keycap: nil, lifetime: 2, anchor: lastFieldFrame)
            status.update { $0.fill.toast = DebugState.Toast(kind: "undone", caption: "Cleared 1 field", grantID: nil) }
        } else {
            let caption = "The field changed after the fill, so it was left as it is."
            overlay.showToast(.error, lead: nil, text: caption, keycap: nil, lifetime: 6, anchor: lastFieldFrame)
            status.update { $0.fill.toast = DebugState.Toast(kind: "error", caption: caption, grantID: nil) }
        }
    }

    func shutdown() {
        watcher.stop()
        toastGrantTimer?.invalidate()
        overlay.hideAll()
        arbiter.invalidate(kind: "fill")
    }

    private func report(_ result: FillResult) {
        status.update { $0.fill.lastResult = result }
        client?.send(result)
    }

    /// What went wrong and what next, without blame or probabilities (`IDENTITY.md` captions).
    nonisolated static func errorCaption(_ reason: String?) -> String {
        switch reason ?? "" {
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

    private static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}

enum NSRunningApplicationBundle {
    static func id(of pid: pid_t) -> String? {
        NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    }
}
