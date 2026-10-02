import ApplicationServices
import AutocompleteCore
import CaretHostCore
import Foundation
import MacContextCapture
import QuartzCore

/// Main-thread orchestration: focus snapshots in, generation, overlay and offers out.
///
/// The invariant it keeps: ghost text is on screen exactly when the arbiter holds an offer for the
/// field state the text was drawn against. Every path that hides the overlay also invalidates the
/// offer, and an offer is published before its text is drawn.
@MainActor
final class HostCoordinator {
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let engine: GhostTextEngine
    private let overlay: GhostOverlay
    private let policy: TargetPolicy
    var executor: InsertionExecutor?
    /// The focused field of the frontmost app after every read (nil when there is none), for the
    /// other coordinators' offers bound to a field.
    var onFocus: ((TargetIdentity?) -> Void)?

    /// The suggestion the visible ghost text derives from.
    private var anchor: GhostSuggestion?
    private var lastContextKey: String?
    private var lastCaretRect: CGRect?
    private var generation: Task<Void, Never>?
    private var generationSerial: UInt64 = 0
    /// Every generation task that may still be inside the model, including cancelled ones:
    /// cancellation is a request, and shutdown must not free llama while one is running.
    private var inFlight: [UInt64: Task<Void, Never>] = [:]
    private var isShuttingDown = false
    /// The key-down whose paint was last measured, so one keystroke yields at most one sample.
    private var measuredKeySequence: UInt64 = 0

    init(
        arbiter: OfferArbiter,
        status: HostStatus,
        engine: GhostTextEngine,
        overlay: GhostOverlay,
        policy: TargetPolicy
    ) {
        self.arbiter = arbiter
        self.status = status
        self.engine = engine
        self.overlay = overlay
        self.policy = policy
    }

    // MARK: - Focus

    func handle(_ change: FocusObserver.Change) {
        guard let snapshot = change.snapshot, let element = change.element,
              let field = FieldReader.read(element) else {
            status.update { $0.focus = nil }
            onFocus?(nil)
            return reset()
        }
        onFocus?(field.identity)
        let context = snapshot.context
        status.update {
            $0.focus = DebugState.Focus(
                pid: field.identity.pid, bundleID: field.identity.bundleID, role: field.role,
                caretUTF16: field.selection.start, valueLength: UTF16Text.length(field.value),
                valueDigest: field.identity.elementRevision
            )
        }
        guard engine.state == .ready,
              policy.allows(pid: field.identity.pid, bundleID: field.identity.bundleID),
              !field.secure, !context.traits.isSecureTextEntry, !context.traits.isPasswordField,
              field.selection.isEmpty
        else { return reset() }
        guard Self.fieldAgrees(field, with: context) else {
            status.increment("suppressed.contextMismatch")
            return reset()
        }

        let key = Self.contextKey(context, field: field.identity)
        if key == lastContextKey {
            // Same field and text, possibly scrolled: re-pin what is shown to the new caret.
            if let shown = overlay.shownText, let rect = snapshot.caretRect, rect != lastCaretRect {
                lastCaretRect = rect
                if overlay.show(shown, at: snapshot, style: FieldStyleProbe.style(of: element)) == nil {
                    clearOffer()
                }
            }
            return
        }
        lastContextKey = key
        lastCaretRect = snapshot.caretRect
        cancelGeneration()

        // The field changed. Keep whatever of the current suggestion still lies ahead of the caret
        // (the user typed its head), re-bound to the new field state; otherwise drop it.
        if let anchor,
           let remaining = SuggestionAnchor.remaining(anchorText: anchor.text, anchor: anchor.context, live: context),
           !remaining.isEmpty {
            present(remaining, snapshot: snapshot, element: element, field: field)
        } else {
            clearOffer()
        }
        startGeneration(snapshot: snapshot, element: element, field: field)
    }

    /// A newer offer from another producer replaced the engine's: its ghost text goes.
    func displaced(_ offer: Offer) {
        guard case .ghost = offer.kind, offer.source == .engine else { return }
        cancelGeneration()
        overlay.hide()
        anchor = nil
        status.update { $0.presentation = nil }
    }

    // MARK: - Tap events (posted to main by the tap thread)

    func offerChanged(_ reason: OfferArbiter.PassReason, key: KeyStroke) {
        // A newer offer may have been published after the tap acted; only react if the arbiter
        // really holds nothing, so visible text and the current offer never come apart.
        let snapshot = arbiter.snapshot()
        let current = snapshot.current
        switch reason {
        case .typedThrough:
            // Redraw to what the arbiter now holds, not "shown minus this key": a callback that
            // arrives after a newer offer was drawn must not shorten that one.
            guard let current else { return }
            let remainder = String(current.text.dropFirst(snapshot.typedSinceOffer.count))
            if let shown = overlay.shownText, shown != remainder, shown.hasSuffix(remainder) {
                overlay.advance(typed: String(shown.dropLast(remainder.count)), remainder: remainder)
            }
        case .dismissed, .expired, .closed:
            guard current == nil else { return }
            cancelGeneration()
            overlay.hide()
            anchor = nil
            status.update { $0.presentation = nil }
        case .noOffer, .otherApp, .toastDismissed, .statusDismissed, .modifierOnly:
            break
        }
    }

    func claimed(_ claim: Claim) {
        guard case .ghost = claim.offer.kind, claim.offer.source == .engine else { return }
        // If the claim was already rejected and a newer offer drawn, leave that one alone.
        if let current = arbiter.snapshot().current, current.id > claim.offer.id { return }
        cancelGeneration()
        overlay.hide()
        // Shift+Tab took one word: keep the suggestion, so the field change that follows re-offers
        // the rest of it (SuggestionAnchor.remaining) instead of generating anew.
        if !claim.choice.wordOnly { anchor = nil }
        lastContextKey = nil
        status.update { $0.presentation = nil }
    }

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard case .ghost = result.claim.offer.kind, result.claim.offer.source == .engine else { return }
        status.increment(result.insertion.ok ? "insertion.ok" : "insertion.\(result.insertion.error ?? "failed")")
    }

    // MARK: - Generation

    private func startGeneration(snapshot: FocusedFieldSnapshot, element: AXUIElement, field: FieldState) {
        generationSerial &+= 1
        let serial = generationSerial
        let keyStamp = status.lastKeyDown()
        let gateNanos = Self.presentationGateNanos(lastGenerationMs: engine.lastGenerationMs)
        let engine = self.engine
        guard !isShuttingDown else { return }
        let task = Task { [weak self] in
            defer { self?.inFlight.removeValue(forKey: serial) }
            // Generation starts at once; the adaptive gate only delays presentation (ADR-080).
            let gate = Task { try? await Task.sleep(nanoseconds: gateNanos) }
            let outcome: GhostTextEngine.Outcome
            do {
                outcome = try await engine.suggest(for: snapshot.context)
            } catch {
                gate.cancel()
                return
            }
            await gate.value
            guard let self, !Task.isCancelled, serial == self.generationSerial else { return }
            self.finishGeneration(outcome, snapshot: snapshot, element: element, field: field, keyStamp: keyStamp)
        }
        generation = task
        inFlight[serial] = task
    }

    /// Stops new generations and waits for every started one to leave the model.
    func drain() async {
        isShuttingDown = true
        cancelGeneration()
        reset()
        for task in Array(inFlight.values) {
            await task.value
        }
    }

    private func finishGeneration(
        _ outcome: GhostTextEngine.Outcome,
        snapshot: FocusedFieldSnapshot,
        element: AXUIElement,
        field: FieldState,
        keyStamp: HostStatus.KeyStamp
    ) {
        guard case .suggestion(let suggestion) = outcome else {
            if case .suppressed(let reason) = outcome { status.increment("suppressed.\(reason)") }
            return clearOffer()
        }
        // Stale-result discard: a key-down after the snapshot means the field has moved, or is
        // about to. Its own snapshot will generate again.
        guard status.lastKeyDown().sequence == keyStamp.sequence else {
            return status.increment("discarded.keyAfterSnapshot")
        }
        guard let fresh = FieldReader.readFocused(),
              fresh.identity == field.identity, fresh.selection == field.selection else {
            return status.increment("discarded.fieldMoved")
        }
        anchor = suggestion
        guard present(suggestion.text, snapshot: snapshot, element: element, field: fresh, keyStamp: keyStamp) else { return }
        recordPaintLatency(keyStamp)
    }

    /// Publishes the offer, then draws it. False when either step refused.
    ///
    /// With `keyStamp`, the offer is withdrawn if any key-down arrived since that stamp: a key
    /// that landed before the publish saw no offer, so the tap could not dismiss it.
    @discardableResult
    private func present(
        _ text: String,
        snapshot: FocusedFieldSnapshot,
        element: AXUIElement,
        field: FieldState,
        keyStamp: HostStatus.KeyStamp? = nil
    ) -> Bool {
        let style = FieldStyleProbe.style(of: element)
        let offer = Offer(text: text, target: field.identity, fieldValue: field.value, caretUTF16: field.selection.start)
        guard let offerID = arbiter.publish(offer) else {
            status.increment("offer.refused")
            overlay.hide()
            return false
        }
        if let keyStamp, status.lastKeyDown().sequence != keyStamp.sequence {
            arbiter.invalidate(offerID: offerID)
            overlay.hide()
            status.increment("discarded.keyDuringPublish")
            return false
        }
        guard let presentation = overlay.show(text, at: snapshot, style: style) else {
            arbiter.invalidate(offerID: offerID)
            status.increment("offer.noPlacement")
            return false
        }
        executor?.remember(offerID: offerID, context: snapshot.context)
        status.update { $0.presentation = presentation.rawValue }
        return true
    }

    private func recordPaintLatency(_ keyStamp: HostStatus.KeyStamp) {
        // Commit the window server transaction so the stamp is taken after the paint request has
        // left this process; the compositor shows it on its next frame.
        CATransaction.flush()
        let now = DispatchTime.now().uptimeNanoseconds
        guard keyStamp.uptimeNanos > 0, keyStamp.sequence != measuredKeySequence else { return }
        let elapsed = Double(now &- keyStamp.uptimeNanos) / 1_000_000
        guard elapsed < 2_000 else { return }
        measuredKeySequence = keyStamp.sequence
        status.latency.record(elapsed)
    }

    // MARK: - Teardown helpers

    private func cancelGeneration() {
        generation?.cancel()
        generation = nil
        generationSerial &+= 1
    }

    private func clearOffer() {
        // The engine's ghost state only: a fill offer, or an offer injected through the debug
        // socket, belongs to another coordinator.
        arbiter.invalidate(kind: "ghost", source: .engine)
        overlay.hide()
        anchor = nil
        status.update { $0.presentation = nil }
    }

    private func reset() {
        cancelGeneration()
        clearOffer()
        lastContextKey = nil
        lastCaretRect = nil
    }

    // MARK: - Pure rules

    /// KeyType's adaptive debounce tiers, applied as a presentation gate (ADR-079/080).
    nonisolated static func presentationGateNanos(lastGenerationMs: Double?) -> UInt64 {
        guard let latency = lastGenerationMs else { return 25_000_000 }
        if latency <= 70 { return 15_000_000 }
        if latency <= 140 { return 25_000_000 }
        return 55_000_000
    }

    /// The model sees KeyType's snapshot text; the guard checks the raw AX value. Refuse to offer
    /// when the two disagree around the caret, since the edit would land somewhere the model did
    /// not see.
    nonisolated static func fieldAgrees(_ field: FieldState, with context: TextFieldContext) -> Bool {
        let total = UTF16Text.length(field.value)
        guard let before = UTF16Text.slice(field.value, start: 0, end: field.selection.start),
              let after = UTF16Text.slice(field.value, start: field.selection.end, end: total)
        else { return false }
        return before.hasSuffix(String(context.beforeCursor.suffix(64)))
            && after.hasPrefix(String(context.afterCursor.prefix(64)))
    }

    /// Text around the caret plus which field holds it, so two fields with equal text differ.
    nonisolated static func contextKey(_ context: TextFieldContext, field: TargetIdentity) -> String {
        [context.beforeCursor, context.afterCursor, field.bundleID, String(field.pid), field.windowID, field.elementID]
            .joined(separator: "\u{1}")
    }
}
