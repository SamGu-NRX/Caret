import AppKit
import ApplicationServices
import CaretCore
import os

/// Joins the pieces: reads the field, asks the backend at a bounded rate,
/// shows the ghost text, owns Tab, and applies the edit.
///
/// The ordering rule that matters: state changes here always publish to the
/// key tap before anything slow happens, so the tap's view of "is an offer
/// visible" can never lag behind the screen.
@MainActor
final class InlineCompletionCoordinator {
    /// Criterion 1: the classifier runs at most once per 2 seconds of
    /// meaningful change. A meaningful change is text or caret movement --
    /// a redraw or a mouse move over the same text is not.
    static let requestInterval: TimeInterval = 2.0
    /// Matches the core's max_offer_age_seconds default. An older offer is
    /// dropped rather than shown.
    static let maxOfferAge: TimeInterval = 30

    private let store = InlineOfferStore()
    private let tap = InlineKeyTap()
    private let preview = InlinePreviewWindow()
    private var provider: InlineCompletionProviding?
    /// The single capture that mints the element and window tokens the guard
    /// later compares. A second instance would mint different tokens and every
    /// acceptance would be rejected as a moved target.
    private let capture: FocusedTargetCapture

    private var pollTimer: Timer?
    private var lastRequestAt: Date?
    /// Unused since InsertionGuard owns validation; kept nil to make the
    /// retained-text path unreachable.
    private var offerBaseText: String?
    /// The newest frame seen while the request window was closed, kept so a
    /// pause right after typing still gets evaluated.
    private var pendingSnapshot: (snapshot: InputSnapshot, target: InlineTarget)?
    private var pendingFlush: DispatchWorkItem?
    private var acceptTask: Task<Void, Never>?

    private let log = Logger(subsystem: "com.caret.app", category: "inline-completion")

    /// Surfaced to the status item. Never carries field content or keystrokes.
    private(set) var status: InlineDisabledReason?
    var onStatusChange: ((InlineDisabledReason?) -> Void)?
    /// The focused field changed in a way that invalidates prepared context,
    /// so action offers built from it stop being valid too.
    var onContextInvalidated: (() -> Void)?

    init(provider: InlineCompletionProviding? = nil, capture: FocusedTargetCapture) {
        self.provider = provider
        self.capture = capture
        wire()
    }

    // MARK: - Wiring

    private func wire() {
        store.onContextChange = { [weak self] context in
            self?.tap.publish(context)
        }
        store.onPresent = { [weak self] offer in
            self?.showPreview(for: offer)
        }
        store.onDismiss = { [weak self] _ in
            self?.preview.hide()
        }

        tap.onAccept = { [weak self] proposalID in
            self?.accept(proposalID: proposalID)
        }
        tap.onDismiss = { [weak self] reason in
            self?.dismissVisible(reason: reason)
        }
        tap.onCancel = { [weak self] reason in
            self?.store.cancel(reason: reason)
        }
        tap.onUnavailable = { [weak self] reason in
            self?.setStatus(reason)
        }
        tap.onSelectChoice = { [weak self] index in
            self?.onSelectChoice?(index)
        }

        provider?.onOffer = { [weak self] offer, generation in
            MainActor.assumeIsolated { self?.receive(offer: offer, generation: generation) }
        }
        provider?.onInvalidated = { [weak self] proposalID, reason in
            MainActor.assumeIsolated { self?.store.invalidate(proposalID: proposalID, reason: reason) }
        }
        provider?.onUnavailable = { [weak self] reason in
            MainActor.assumeIsolated { self?.setStatus(reason) }
        }
    }

    /// Caret's own visible action choices, owned by the picker.
    var onSelectChoice: ((Int) -> Void)?
    func setVisibleChoiceCount(_ count: Int) { store.setVisibleChoiceCount(count) }

    // MARK: - Lifecycle

    func start() {
        guard let provider else {
            // Criterion 6: no backend means no completions and a visible
            // reason. Nothing is mocked here.
            setStatus(.noProvider)
            return
        }
        do {
            try provider.start()
        } catch {
            log.error("inline provider failed to start")
            setStatus(.providerError)
            return
        }
        // The tap is armed for Caret's own Cmd-1..3 choices only; the router
        // passes Tab through to Teddy's controller.
        guard tap.start() else { return }
        setStatus(nil)

        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        pendingFlush?.cancel()
        pendingFlush = nil
        pendingSnapshot = nil
        acceptTask?.cancel()
        acceptTask = nil
        tap.stop()
        preview.hide()
        store.cancel(reason: .focusChanged)
    }

    // MARK: - Capture

    private func poll() {
        guard let provider else { return }

        switch capture.capture(now: Date()) {
        case .unchanged:
            // Nothing new to judge and any live offer is still about the text
            // in front of the user.
            return

        case .suppressed(let suppression, let invalidatesPriorContext):
            if invalidatesPriorContext {
                onContextInvalidated?()
                // The user is no longer in the field the offer was about. This
                // includes the composing case, where whether a composition is
                // in progress is not observable: an offer that might land
                // inside one is taken down rather than left up.
                store.cancel(reason: .focusChanged)
            }
            setStatus(Self.status(for: suppression))

        case .captured(let snapshot):
            setStatus(nil)
            let target = InlineTarget(snapshot.target)
            store.updateTarget(target)
            maybeRequest(snapshot, target: target, provider: provider)
        }
    }

    /// Only the reasons a user can act on become visible status. A field that
    /// simply is not a text field is not a problem to report.
    private static func status(for suppression: FocusedTargetCapture.Suppression) -> InlineDisabledReason? {
        switch suppression {
        case .accessibilityNotTrusted: return .accessibilityDenied
        case .secureField: return .secureField
        case .appExcluded: return .excludedApp
        case .imeCompositionUnobservable: return .composing
        case .noFocusedApplication, .noFocusedElement, .unsupportedRole,
             .valueUnreadable, .selectionUnreadable, .processMismatch,
             .windowUnavailable, .nearbyTextUnbounded:
            return nil
        }
    }

    /// Bounded request rate. The capture already suppressed an unchanged
    /// reading, so reaching here means the text or caret actually moved.
    private func maybeRequest(_ snapshot: InputSnapshot, target: InlineTarget, provider: InlineCompletionProviding) {
        guard status == nil else { return }
        guard store.visibleOffer == nil, !store.acceptanceInFlight else { return }

        // Blocker 3: this used to drop any snapshot arriving inside the
        // 2 second window. The capture has already deduped, so a dropped
        // snapshot is real typing that is simply never evaluated -- if the
        // user pauses right after, their latest text is the one that never
        // gets judged. Two independent cadence schedulers cannot both throttle
        // without losing changes, so the newest frame is retained and sent
        // when the window opens, and the core's own admission owns the rest.
        if let lastRequestAt, Date().timeIntervalSince(lastRequestAt) < Self.requestInterval {
            pendingSnapshot = (snapshot, target)
            schedulePendingFlush()
            return
        }
        pendingSnapshot = nil

        lastRequestAt = Date()

        // Blocker 4: the real selection is sent. Refusing a non-empty
        // selection here blocked every selection-driven action -- revise,
        // summarize, translate -- before the judge ever saw the context. Only
        // inline completion needs a collapsed caret, and the offer store
        // already refuses an inline offer that does not match.
        let request = InlineCompletionRequest(
            generation: store.generation,
            revision: snapshot.revision,
            target: target,
            role: snapshot.role,
            nearbyText: snapshot.nearbyText,
            textOffset: snapshot.textOffset,
            caret: snapshot.caret,
            selection: NSRange(
                location: snapshot.selection.start,
                length: max(0, snapshot.selection.end - snapshot.selection.start)
            ),
            secure: snapshot.secure,
            imeComposing: snapshot.imeComposing,
            appExcluded: snapshot.appExcluded,
            valueLength: snapshot.valueLength ?? UTF16Text.length(snapshot.nearbyText)
        )

        Task { [weak self] in
            do {
                try await provider.requestCompletion(request)
            } catch {
                await MainActor.run { self?.setStatus(.providerError) }
            }
        }
    }

    /// Sends the retained frame once the interval has elapsed, unless newer
    /// input has already superseded it.
    private func schedulePendingFlush() {
        guard pendingFlush == nil else { return }
        let elapsed = lastRequestAt.map { Date().timeIntervalSince($0) } ?? Self.requestInterval
        let delay = max(0.05, Self.requestInterval - elapsed)
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.pendingFlush = nil
                guard let pending = self.pendingSnapshot, let provider = self.provider else { return }
                self.pendingSnapshot = nil
                self.maybeRequest(pending.snapshot, target: pending.target, provider: provider)
            }
        }
        pendingFlush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Offers

    private func receive(offer: InlineOffer, generation: Int) {
        guard Date().timeIntervalSince(offer.createdAt) < Self.maxOfferAge else {
            store.cancel(reason: .expired)
            return
        }
        // present() itself refuses a late or mistargeted answer; this is the
        // only place an offer can reach the screen.
        store.present(offer, generation: generation)
    }

    private func showPreview(for offer: InlineOffer) {
        guard let element = InlineFieldAccess.focusedElement(forPID: offer.target.pid) else {
            store.cancel(reason: .staleTarget)
            return
        }
        let caretRect = InlineCaretGeometry.caretRect(for: element, caretUTF16: offer.replaceEnd)
        let fieldRect = AXHelpers.frame(element) ?? .zero
        preview.show(
            InlinePreviewPresentation(
                text: offer.replacement,
                caretRect: caretRect ?? .zero,
                fieldRect: fieldRect,
                placement: InlineCaretGeometry.placement(caretRect: caretRect, fieldRect: fieldRect),
                acceptHint: InlineKeyTap.acceptHint,
                fontPointSize: InlineCaretGeometry.fontPointSize(for: element)
            )
        )
        announce(offer)
    }

    /// Ghost text is pixels only, so a VoiceOver user would otherwise have no
    /// way to know a suggestion exists or that Tab now means something new.
    ///
    /// Low priority on purpose: this fires while the user is typing, and an
    /// announcement that interrupts speech mid-word would make the feature
    /// worse than silence. The completion text is spoken because a suggestion
    /// the user cannot hear is not one they can decide about.
    private func announce(_ offer: InlineOffer) {
        guard NSWorkspace.shared.isVoiceOverEnabled else { return }
        NSAccessibility.post(
            element: NSApp as Any,
            notification: .announcementRequested,
            userInfo: [
                .announcement: "Suggestion: \(offer.replacement). Press Tab to accept.",
                .priority: NSAccessibilityPriorityLevel.low.rawValue,
            ]
        )
    }

    private func dismissVisible(reason: InlineCancelReason) {
        guard let offer = store.visibleOffer else { return }
        store.cancel(reason: reason)
        Task { [weak self] in await self?.provider?.dismiss(proposalID: offer.proposalID) }
    }

    // MARK: - Acceptance

    /// One acceptance, revalidated twice: once before asking the backend and
    /// again on its reply, because the user keeps typing while the request is
    /// in flight.
    private func accept(proposalID: String) {
        guard let claim = store.claimAcceptance(proposalID: proposalID) else { return }
        preview.hide()

        // First revalidation, at the keystroke: refuse before asking the core
        // if the field already moved.
        guard let coreEdit = claim.offer.coreEdit,
              let live = capture.liveTarget(),
              case .success = InsertionGuard.approve(
                  edit: coreEdit,
                  live: live,
                  createdAt: claim.offer.createdAt
              )
        else {
            log.info("inline acceptance refused before request")
            store.finishAcceptance(success: false)
            return
        }

        acceptTask?.cancel()
        acceptTask = Task { [weak self] in
            guard let self, let provider = self.provider else { return }
            do {
                let edit = try await provider.accept(
                    proposalID: claim.offer.proposalID,
                    revision: claim.offer.revision,
                    target: claim.offer.target
                )
                await MainActor.run { self.applyAccepted(edit, generation: claim.generation) }
            } catch {
                await MainActor.run {
                    self.log.error("inline acceptance rejected by core")
                    self.store.finishAcceptance(success: false)
                }
            }
        }
    }

    private func applyAccepted(_ edit: InlineAcceptedEdit, generation: Int) {
        guard generation == store.generation, store.acceptanceInFlight else {
            log.info("inline edit dropped: superseded while in flight")
            store.finishAcceptance(success: false)
            return
        }

        // Second revalidation, on the reply: the user kept typing while the
        // request was in flight, so the field is read again, not remembered.
        guard let live = capture.liveTarget() else {
            store.finishAcceptance(success: false)
            return
        }
        guard let coreEdit = InlineEditBuilder.make(
            proposalID: edit.proposalID,
            target: edit.target.identity,
            replaceStart: edit.replaceStart,
            replaceEnd: edit.replaceEnd,
            replacement: edit.replacement,
            originalDigest: edit.originalDigest
        ) else {
            store.finishAcceptance(success: false)
            return
        }
        switch InsertionGuard.approve(edit: coreEdit, live: live, createdAt: Date()) {
        case .failure(let rejection):
            log.error("inline insert refused: \(rejection.shortReason, privacy: .public)")
            store.finishAcceptance(success: false)
        case .success(let approved):
            guard let element = InlineFieldAccess.focusedElement(forPID: approved.target.pid) else {
                store.finishAcceptance(success: false)
                return
            }
            switch InlineFieldAccess.apply(approved, to: element) {
            case .success:
                capture.invalidate()
                store.finishAcceptance(success: true)
            case .failure(let failure):
                log.error("inline insert failed: \(String(describing: failure), privacy: .public)")
                store.finishAcceptance(success: false)
            }
        }
    }

    // MARK: - Status

    private func setStatus(_ reason: InlineDisabledReason?) {
        guard status != reason else { return }
        status = reason
        store.setDisabled(reason)
        if reason != nil { preview.hide() }
        onStatusChange?(reason)
    }
}
