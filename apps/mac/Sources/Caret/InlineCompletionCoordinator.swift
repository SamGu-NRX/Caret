import AppKit
import ApplicationServices
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

    private var pollTimer: Timer?
    private var lastRequestAt: Date?
    private var lastRequestedRevision: String?
    /// Text the offer was computed against, retained so insertion can check
    /// live content equality rather than trusting a hash convention.
    private var offerBaseText: String?
    private var acceptTask: Task<Void, Never>?

    private let log = Logger(subsystem: "com.caret.app", category: "inline-completion")

    /// Surfaced to the status item. Never carries field content or keystrokes.
    private(set) var status: InlineDisabledReason?
    var onStatusChange: ((InlineDisabledReason?) -> Void)?

    init(provider: InlineCompletionProviding? = nil) {
        self.provider = provider
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
        guard AXHelpers.isTrusted() else {
            setStatus(.accessibilityDenied)
            return
        }
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
        acceptTask?.cancel()
        acceptTask = nil
        tap.stop()
        preview.hide()
        store.cancel(reason: .focusChanged)
    }

    // MARK: - Capture

    private func poll() {
        guard AXHelpers.isTrusted() else {
            setStatus(.accessibilityDenied)
            store.updateTarget(nil)
            return
        }
        guard let reading = InlineFieldAccess.readFocusedField() else {
            store.updateTarget(nil)
            return
        }
        if reading.secure {
            setStatus(.secureField)
            store.updateTarget(nil)
            return
        }
        guard InlineFieldAccess.isEditable(role: reading.role) else {
            store.updateTarget(nil)
            return
        }
        if status == .secureField || status == .excludedApp { setStatus(nil) }

        store.updateTarget(reading.target)
        maybeRequest(reading)
    }

    /// Bounded request rate. Skipped entirely when the text and caret have not
    /// moved since the last request, so an idle caret costs nothing.
    private func maybeRequest(_ reading: InlineFieldReading) {
        guard status == nil, let provider else { return }
        guard store.visibleOffer == nil, !store.acceptanceInFlight else { return }

        let revision = reading.target.elementRevision
        guard revision != lastRequestedRevision else { return }
        if let lastRequestAt, Date().timeIntervalSince(lastRequestAt) < Self.requestInterval { return }
        // Only complete at a collapsed caret at the end of a word; completing
        // into the middle of a selection is a different feature.
        guard reading.selection.length == 0 else { return }

        lastRequestedRevision = revision
        lastRequestAt = Date()

        let window = InlineWindowBuilder.window(text: reading.text, caret: reading.selection.location)
        let request = InlineCompletionRequest(
            generation: store.generation,
            revision: store.generation,
            target: reading.target,
            role: reading.role,
            nearbyText: window.text,
            textOffset: window.offset,
            caret: reading.selection.location,
            selection: reading.selection,
            secure: reading.secure,
            imeComposing: false,
            appExcluded: false,
            valueLength: reading.text.utf16.count
        )
        offerBaseText = reading.text

        Task { [weak self] in
            do {
                try await provider.requestCompletion(request)
            } catch {
                await MainActor.run { self?.setStatus(.providerError) }
            }
        }
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
        guard let reading = InlineFieldAccess.readFocusedField(),
              reading.target == offer.target
        else {
            store.cancel(reason: .staleTarget)
            return
        }
        let caretRect = InlineCaretGeometry.caretRect(for: reading.element, caretUTF16: offer.replaceEnd)
        let fieldRect = AXHelpers.frame(reading.element) ?? .zero
        preview.show(
            InlinePreviewPresentation(
                text: offer.replacement,
                caretRect: caretRect ?? .zero,
                fieldRect: fieldRect,
                placement: InlineCaretGeometry.placement(caretRect: caretRect, fieldRect: fieldRect),
                acceptHint: InlineKeyTap.acceptHint,
                fontPointSize: InlineCaretGeometry.fontPointSize(for: reading.element)
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

        guard let baseText = offerBaseText else {
            store.finishAcceptance(success: false)
            return
        }

        // First revalidation: the field as it is at the keystroke.
        guard let before = InlineFieldAccess.readFocusedField(),
              InlineFieldAccess.validate(reading: before, against: claim.offer, expectedText: baseText) == nil
        else {
            log.info("inline acceptance refused: target changed before request")
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
                await MainActor.run { self.applyAccepted(edit, base: baseText, generation: claim.generation) }
            } catch {
                await MainActor.run {
                    self.log.error("inline acceptance rejected by core")
                    self.store.finishAcceptance(success: false)
                }
            }
        }
    }

    private func applyAccepted(_ edit: InlineAcceptedEdit, base: String, generation: Int) {
        // The answer is only allowed to act if nothing invalidated the offer
        // while it was in flight.
        guard generation == store.generation, store.acceptanceInFlight else {
            log.info("inline edit dropped: superseded while in flight")
            store.finishAcceptance(success: false)
            return
        }

        let offer = InlineOffer(
            proposalID: edit.proposalID,
            revision: 0,
            target: edit.target,
            replaceStart: edit.replaceStart,
            replaceEnd: edit.replaceEnd,
            replacement: edit.replacement,
            originalDigest: edit.originalDigest,
            createdAt: Date()
        )

        // Second revalidation, inside apply(): reads the live field again and
        // refuses if the user moved on. Never inserts into a newly focused
        // field.
        switch InlineFieldAccess.apply(offer: offer, expectedText: base) {
        case .success:
            store.finishAcceptance(success: true)
        case .failure(let failure):
            log.error("inline insert refused: \(String(describing: failure), privacy: .public)")
            store.finishAcceptance(success: false)
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
