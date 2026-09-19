import Foundation

/// Owns which offer is visible and who is allowed to accept it.
///
/// Two problems drive the design. First, a provider answer arrives long after
/// the keystroke that asked for it, so an answer can land after the user has
/// already typed past it; a monotonic `generation` fences those out. Second,
/// Tab arrives on the event tap while an acceptance may already be in flight,
/// so acceptance is a one-shot claim rather than a re-entrant call.
///
/// Main-actor isolated on purpose: the event tap publishes an immutable
/// `InlineKeyContext` snapshot for the tap thread to read, and never lets the
/// tap thread touch this state directly.
@MainActor
final class InlineOfferStore {
    enum State: Equatable {
        case idle
        case visible(InlineOffer)
        /// Accepted; the edit is being applied. No second acceptance.
        case accepting(InlineOffer)
    }

    private(set) var state: State = .idle

    /// Bumped by every cancellation and every new target. An offer or an
    /// acceptance reply carrying an older generation is dropped rather than
    /// shown, which is what stops a late answer from resurrecting a preview
    /// the user already dismissed.
    private(set) var generation: Int = 0

    /// The field the user is in right now, as last read from AX.
    private(set) var currentTarget: InlineTarget?

    private(set) var disabledReason: InlineDisabledReason?

    /// Action choices Caret is showing. Cmd-1..3 only bind while this is
    /// non-empty, so the host app keeps those chords the rest of the time.
    private(set) var visibleChoiceCount: Int = 0

    var onPresent: ((InlineOffer) -> Void)?
    var onDismiss: ((InlineCancelReason) -> Void)?
    /// Told about every state change so the tap's published snapshot stays
    /// in step with what is actually on screen.
    var onContextChange: ((InlineKeyContext) -> Void)?

    var visibleOffer: InlineOffer? {
        if case .visible(let offer) = state { return offer }
        return nil
    }

    var acceptanceInFlight: Bool {
        if case .accepting = state { return true }
        return false
    }

    /// The snapshot the event tap reads. Interception is off unless an offer
    /// is actually on screen or Caret owns visible choices, so a keystroke in
    /// an ordinary field costs one boolean check.
    var keyContext: InlineKeyContext {
        InlineKeyContext(
            visibleProposalID: visibleOffer?.proposalID,
            acceptanceInFlight: acceptanceInFlight,
            visibleChoiceCount: visibleChoiceCount,
            interceptionEnabled: disabledReason == nil
        )
    }

    // MARK: - Target tracking

    /// Called whenever the focused field or its text changes. A change of
    /// field, text or caret cancels any visible offer at once: criterion 2
    /// requires the offer die on the input change, not when the next answer
    /// happens to arrive.
    func updateTarget(_ target: InlineTarget?) {
        let previous = currentTarget
        currentTarget = target

        guard let visible = visibleOffer ?? acceptingOffer else {
            if previous != target { bumpGeneration() }
            publishContext()
            return
        }

        guard let target else {
            cancel(reason: .focusChanged)
            return
        }

        if !visible.target.isSameField(as: target) {
            cancel(reason: .focusChanged)
        } else if visible.target.elementRevision != target.elementRevision {
            // Same field, different text: the offer was about text that no
            // longer exists.
            cancel(reason: .userTyped)
        }
    }

    private var acceptingOffer: InlineOffer? {
        if case .accepting(let offer) = state { return offer }
        return nil
    }

    func setDisabled(_ reason: InlineDisabledReason?) {
        guard disabledReason != reason else { return }
        disabledReason = reason
        if reason != nil, visibleOffer != nil {
            cancel(reason: reason == .accessibilityDenied ? .permissionLost : .excludedField)
            return
        }
        publishContext()
    }

    func setVisibleChoiceCount(_ count: Int) {
        guard visibleChoiceCount != max(0, count) else { return }
        visibleChoiceCount = max(0, count)
        publishContext()
    }

    // MARK: - Offers

    /// Show an offer the core produced for `generation`.
    ///
    /// Returns false and shows nothing when the answer is late, is for another
    /// field, or arrives while an acceptance is in flight. A rejected offer is
    /// dropped silently by design: the next context change schedules the next
    /// attempt, so there is nothing to retry here.
    @discardableResult
    func present(_ offer: InlineOffer, generation offerGeneration: Int) -> Bool {
        guard disabledReason == nil else { return false }
        guard offerGeneration == generation else { return false }
        guard case .idle = state else { return false }
        guard let target = currentTarget else { return false }
        guard offer.target == target else { return false }
        guard !offer.replacement.isEmpty else { return false }

        state = .visible(offer)
        onPresent?(offer)
        publishContext()
        return true
    }

    /// Claim the right to accept. Exactly one caller can succeed per offer;
    /// every later caller gets nil, which is what makes a held Tab or a double
    /// keystroke unable to apply the edit twice.
    func claimAcceptance(proposalID: String) -> (offer: InlineOffer, generation: Int)? {
        guard disabledReason == nil else { return nil }
        guard case .visible(let offer) = state, offer.proposalID == proposalID else { return nil }
        state = .accepting(offer)
        publishContext()
        return (offer, generation)
    }

    /// The edit landed. Clears state and fences off anything still in flight.
    func finishAcceptance(success: Bool) {
        guard case .accepting = state else { return }
        state = .idle
        bumpGeneration()
        onDismiss?(success ? .accepted : .staleTarget)
        publishContext()
    }

    func cancel(reason: InlineCancelReason) {
        let hadSomethingVisible = state != .idle
        state = .idle
        // Bump even when nothing was on screen: a request already in flight
        // for the old text must not be allowed to show up later.
        bumpGeneration()
        if hadSomethingVisible { onDismiss?(reason) }
        publishContext()
    }

    /// The core says a specific proposal stopped being valid. Ignored when it
    /// names an offer that is no longer the visible one.
    func invalidate(proposalID: String, reason: InlineCancelReason) {
        guard let visible = visibleOffer, visible.proposalID == proposalID else { return }
        cancel(reason: reason)
    }

    private func bumpGeneration() {
        generation &+= 1
    }

    private func publishContext() {
        onContextChange?(keyContext)
    }
}
