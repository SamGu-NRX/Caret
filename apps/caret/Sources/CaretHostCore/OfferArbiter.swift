import CaretScreenCore
import Foundation
import os

/// Owns the one offer Tab may take, and hands it out at most once.
///
/// The tap thread calls `handleKeyDown` for every key-down. The main thread publishes and
/// invalidates offers. The insertion queue confirms a claim against a fresh read of the field and
/// reports how insertion went. One unfair lock covers all of it; every critical section is a few
/// field assignments, so the tap callback never waits on model work or Accessibility.
///
/// Lifecycle of an offer: `publish` makes it current. A plain Tab claims it, which removes it, so
/// a second Tab finds nothing and passes through. Any other key that does not type the offer's
/// next characters removes it too. While a claim is being inserted, `publish` refuses new offers
/// so a stale snapshot cannot re-offer text that is already on its way into the field.
///
/// Key ownership follows `SURFACES.md` section 8 through `KeyOwnership`. Three things can hold
/// keys here: the current offer (ghost text and its alternatives, a fill value, an action line or
/// a pop-up), the result toast (⌘Z, Esc), and a status line (working, error). The offer's
/// navigation state (`OfferUI`: which alternative, which row) lives here too, so two quick arrow
/// presses move two steps even before the main thread has drawn the first. A key headed for an
/// app other than the surface's own (`KeyStroke.targetPID`) neither takes nor dismisses anything.
public final class OfferArbiter: @unchecked Sendable {
    public enum PassReason: String, Codable, Sendable {
        /// No offer exists; the key keeps its native meaning.
        case noOffer
        /// The offer outlived `maxAgeSeconds`; it was removed.
        case expired
        /// The key typed the offer's next characters; the offer stays, shortened.
        case typedThrough
        /// The key diverged from the offer; it was removed.
        case dismissed
        /// The key is headed for a different app than the offer's, or its target is unknown.
        /// Nothing was taken or dismissed.
        case otherApp
        /// No offer, but the key dismissed the result toast.
        case toastDismissed
        /// No offer, but the key dismissed the working or error line.
        case statusDismissed
        /// Esc closed the offer (consumed, not passed; reported through the same callback).
        case closed
        /// A modifier key alone. Never dismisses anything (`SURFACES.md` section 8).
        case modifierOnly
    }

    public enum Decision: Equatable, Sendable {
        /// Swallow the key and insert this claim.
        case consume(Claim)
        /// Swallow ⌘Z and revert this write.
        case undo(UndoGrant)
        /// Swallow Esc: it closed the toast.
        case closeToast
        /// Swallow the key: it moved within the offer (an alternative, a row, a reveal). Redraw
        /// from this state.
        case navigate(offerID: UInt64, ui: OfferUI)
        /// Swallow Esc: it closed the offer.
        case closeOffer(offerID: UInt64)
        /// Swallow Esc on a working line that has run 3 s: stop the work and revert partial writes.
        case stopWork(StatusLine)
        /// Swallow Esc: it closed the error line.
        case closeStatus(StatusLine)
        case pass(PassReason)
    }

    public enum ClaimOutcome: Equatable, Codable, Sendable {
        case pending
        case rejected(String)
        case approved
        case inserted
        case insertFailed(String)
        /// An action line or pop-up action, handed to whoever runs it. Nothing is inserted here.
        case accepted
    }

    public struct ClaimRecord: Equatable, Codable, Sendable {
        public var claimID: UInt64
        public var offerID: UInt64
        public var claimedAt: Date
        public var insertionLength: Int
        public var outcome: ClaimOutcome
        /// Which candidate, action and row were taken.
        public var candidate: Int?
        public var actionID: String?
        public var row: Int?
        public var wordOnly: Bool?
    }

    public struct Snapshot: Equatable, Sendable {
        public var current: Offer?
        public var typedSinceOffer: String
        public var lastClaim: ClaimRecord?
        public var insertingClaimID: UInt64?
        public var toast: UndoGrant?
        public var statusLine: StatusLine?
        public var ui: OfferUI
        public var publishedCount: UInt64
        public var claimCount: UInt64
        public var refusedPublishCount: UInt64
        /// The last writing offer the user closed by choosing Original, so its producer can stop
        /// marking that text.
        public var keptOriginalOfferID: UInt64?
    }

    private struct State {
        var current: Offer?
        /// The current offer is on screen. One published with `shown: false` takes no key until
        /// `reveal` says it was drawn.
        var shown = true
        var ui = OfferUI()
        var statusLine: StatusLine?
        var nextStatusID: UInt64 = 1
        var typedSinceOffer = ""
        var nextOfferID: UInt64 = 1
        var nextClaimID: UInt64 = 1
        var insertingClaimID: UInt64?
        /// The field state (element and revision) the last insertion started from. An offer for
        /// that state is stale by construction once the insertion lands. The whole identity, not
        /// only the revision: every empty field shares one revision, and the next field of a form
        /// must stay offerable after the first is filled.
        var consumedTarget: TargetIdentity?
        var toast: UndoGrant?
        var nextGrantID: UInt64 = 1
        var lastClaim: ClaimRecord?
        var publishedCount: UInt64 = 0
        var claimCount: UInt64 = 0
        var refusedPublishCount: UInt64 = 0
        var keptOriginalOfferID: UInt64?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    /// Called on the publishing thread, outside the lock, with an offer that a newer `publish`
    /// replaced, so whoever drew it can take it down. Set once, before offers flow.
    public var onDisplaced: (@Sendable (Offer) -> Void)?

    public init() {}

    // MARK: - Main thread

    /// Makes `offer` the current one. Returns its id, or nil when refused because a claim is being
    /// inserted or the offer is for the field revision an insertion just consumed.
    @discardableResult
    /// `compact`: the offer starts as its compact line (`OfferUI.compact`), decided before publishing
    /// so the tap never sees a pop-up's keys on a line that shows none of its rows.
    /// `shown: false`: the offer is drawn after it is published, and drawing can fail, so it owns no
    /// key until `reveal` (V1a check 4 review: a Tab between the publish and a failed draw would
    /// have taken text nobody saw). Any key headed for its app meanwhile passes through and
    /// dismisses it, as typing dismisses a shown one.
    public func publish(_ offer: Offer, compact: Bool = false, shown: Bool = true) -> UInt64? {
        let (id, displaced): (UInt64?, Offer?) = state.withLock { s in
            guard s.insertingClaimID == nil, offer.target != s.consumedTarget,
                  s.current.map({ Self.mayReplace($0, ui: s.ui, with: offer) }) ?? true
            else {
                s.refusedPublishCount &+= 1
                return (nil, nil)
            }
            let displaced = s.current
            // The field has moved past the consumed state; returning to it later is a new state.
            s.consumedTarget = nil
            var stamped = offer
            stamped.id = s.nextOfferID
            s.nextOfferID &+= 1
            s.current = stamped
            s.shown = shown
            s.ui = OfferUI(initialFor: stamped)
            s.ui.compact = compact
            s.typedSinceOffer = ""
            s.publishedCount &+= 1
            return (stamped.id, displaced)
        }
        if let displaced { onDisplaced?(displaced) }
        return id
    }

    /// Swaps the current offer's content for `offer` and keeps its id, so an offer the helper sent
    /// again under the same key redraws in place. The user's place stays: the alternative they
    /// moved to, clamped to the new count, and the list open while two or more remain. So does the
    /// field as the offer first read it: what was typed since is counted from there
    /// (`typedSinceOffer`), and a baseline read after the typing would count it twice. Nil when
    /// `offerID` is no longer current (a key took it), an insertion is running, or the text typed
    /// since the offer no longer leads the new top candidate; the caller then shows it afresh.
    public func replace(offerID: UInt64, with offer: Offer) -> OfferUI? {
        state.withLock { s in
            guard let current = s.current, current.id == offerID, s.insertingClaimID == nil,
                  offer.text.hasPrefix(s.typedSinceOffer) else { return nil }
            var stamped = offer
            stamped.id = offerID
            stamped.target = current.target
            stamped.fieldValue = current.fieldValue
            stamped.caretUTF16 = current.caretUTF16
            s.current = stamped
            let count = stamped.candidates.count
            s.ui.candidate = min(s.ui.candidate, max(count - 1, 0))
            if count < 2 { s.ui.open = false }
            return s.ui
        }
    }

    /// The offer published with `shown: false` is on screen now and owns its keys. False when it is
    /// no longer the current one (a key dismissed it, or a newer offer replaced it); the caller then
    /// takes down what it drew.
    @discardableResult
    public func reveal(offerID: UInt64) -> Bool {
        state.withLock { s in
            guard s.current?.id == offerID else { return false }
            s.shown = true
            return true
        }
    }

    /// Removes the current offer. With `offerID`, only that offer; a newer one survives.
    public func invalidate(offerID: UInt64? = nil) {
        state.withLock { s in
            guard let current = s.current else { return }
            if let offerID, current.id != offerID { return }
            s.current = nil
            s.typedSinceOffer = ""
        }
    }

    /// Removes the current offer only if it is of the given kind (and, with `source`, from that
    /// producer), so the ghost-text path clearing its own state cannot take down a fill offer or an
    /// injected one, or the reverse.
    public func invalidate(kind: String, source: OfferSource? = nil) {
        state.withLock { s in
            guard let current = s.current, current.kind.name == kind else { return }
            if let source, current.source != source { return }
            s.current = nil
            s.typedSinceOffer = ""
        }
    }

    /// Shows a working or error line, replacing any earlier one. Returns its id.
    @discardableResult
    public func showStatus(_ line: StatusLine) -> UInt64 {
        state.withLock { s in
            var stamped = line
            stamped.id = s.nextStatusID
            s.nextStatusID &+= 1
            s.statusLine = stamped
            return stamped.id
        }
    }

    /// Removes the status line. With `id`, only that one.
    public func clearStatus(id: UInt64? = nil) {
        state.withLock { s in
            guard let line = s.statusLine else { return }
            if let id, line.id != id { return }
            s.statusLine = nil
        }
    }

    /// Makes `grant` the write ⌘Z reverts, replacing any earlier one. Returns its id.
    @discardableResult
    public func showToast(_ grant: UndoGrant) -> UInt64 {
        state.withLock { s in
            var stamped = grant
            stamped.id = s.nextGrantID
            s.nextGrantID &+= 1
            s.toast = stamped
            return stamped.id
        }
    }

    /// Removes the toast. With `grantID`, only that one.
    public func dismissToast(grantID: UInt64? = nil) {
        state.withLock { s in
            guard let toast = s.toast else { return }
            if let grantID, toast.id != grantID { return }
            s.toast = nil
        }
    }

    // MARK: - Tap thread

    /// Decides one key-down. Constant time apart from a prefix check on the offer text.
    public func handleKeyDown(_ key: KeyStroke, now: Date = Date()) -> Decision {
        if KeyStroke.modifierKeyCodes.contains(key.keyCode) { return .pass(.modifierOnly) }
        let keyClass = KeyClass(key)
        return state.withLock { s in
            var dismissedLine: PassReason?
            if let toast = s.toast {
                if toast.isExpired(at: now) {
                    s.toast = nil
                } else if key.isHeaded(to: toast.target.pid) {
                    // A question about the run this toast reports on (B19 keep or promote) shares its
                    // keys: ⌘Z still undoes the run, Tab answers and leaves the toast, Esc declines and
                    // closes both. Any other key dismisses both, as it would either alone.
                    let question = Self.question(s, for: key)
                    if key.isUndo {
                        s.toast = nil
                        return .undo(toast)
                    }
                    if let question, key.isPlainEscape {
                        s.toast = nil
                        Self.clearOffer(&s)
                        return .closeOffer(offerID: question.id)
                    }
                    if question == nil || !key.isPlainTab {
                        s.toast = nil
                        if key.isPlainEscape { return .closeToast }
                        // Any other key passes through and dismisses the toast; ⌘Z is the host's again.
                        dismissedLine = .toastDismissed
                    }
                }
            }
            if let line = s.statusLine, key.isHeaded(to: line.pid) {
                // A result line with a question about its run (a hand-off that may be kept as a
                // skill) shares keys as the toast does: Tab answers and leaves the line, Esc declines
                // and closes both.
                let question = line.isWorking ? nil : Self.question(s, for: key)
                if let question, key.isPlainEscape {
                    s.statusLine = nil
                    Self.clearOffer(&s)
                    return .closeOffer(offerID: question.id)
                }
                if question == nil || !key.isPlainTab {
                    s.statusLine = nil
                    if KeyOwnership.owns(line.surface(at: now), keyClass) {
                        if case .working = line.kind { return .stopWork(line) }
                        return .closeStatus(line)
                    }
                    dismissedLine = dismissedLine ?? .statusDismissed
                }
            }

            guard let offer = s.current else { return .pass(dismissedLine ?? .noOffer) }
            guard key.isHeaded(to: offer.target.pid) else { return .pass(.otherApp) }
            if offer.isExpired(at: now) {
                Self.clearOffer(&s)
                return .pass(.expired)
            }
            guard s.shown else {
                Self.clearOffer(&s)
                return .pass(.dismissed)
            }

            let surface = Self.surface(of: offer, ui: s.ui, typed: s.typedSinceOffer)
            guard KeyOwnership.owns(surface, keyClass) else {
                // Typing the head of ghost text keeps the rest on offer. Everything else that passes
                // through dismisses: a fill value is all or nothing (SURFACES.md section 5), open
                // alternatives close on typing, and a Command-digit with nothing numbered visible
                // keeps the host's meaning (Fable plan, section 5, change 6).
                if case .ghost = surface, let typed = key.text, !typed.isEmpty, !key.command, !key.control {
                    let remaining = offer.text.dropFirst(s.typedSinceOffer.count)
                    if remaining.hasPrefix(typed), remaining.count > typed.count {
                        s.typedSinceOffer += typed
                        return .pass(.typedThrough)
                    }
                }
                Self.clearOffer(&s)
                return .pass(.dismissed)
            }
            return Self.act(keyClass, on: offer, surface: surface, state: &s, now: now)
        }
    }

    /// The current offer when it is a question about a run's result (`ActionLine.answersToast`) and
    /// `key` is headed for its app.
    private static func question(_ s: State, for key: KeyStroke) -> Offer? {
        guard let current = s.current, current.kind.actionLine?.answersToast == true, key.isHeaded(to: current.target.pid) else { return nil }
        return current
    }

    /// An owned key on the current offer.
    private static func act(_ key: KeyClass, on offer: Offer, surface: Surface, state s: inout State, now: Date) -> Decision {
        let spec = offer.visibleSpec(ui: s.ui)
        let rows = spec?.rowCount ?? 0
        func navigate(_ change: (inout OfferUI) -> Void) -> Decision {
            change(&s.ui)
            return .navigate(offerID: offer.id, ui: s.ui)
        }
        func take(_ choice: Choice) -> Decision {
            .consume(claim(offer, choice: choice, state: &s, now: now))
        }
        func takeAction(_ action: PopupSpec.Action?) -> Decision {
            // An action that changes the pop-up reveals, whichever key it is bound to.
            if let action, action.reveal != nil, let spec {
                return navigate { ui in
                    ui.revealed = action.id
                    ui.highlight = spec.applyingReveal(of: action.id).choices?.selected
                }
            }
            return take(Choice(actionID: action?.id, row: rows > 0 ? s.ui.highlight : nil, revealed: s.ui.revealed, expanded: s.ui.expanded))
        }

        if case .writing(let writing) = offer.kind {
            return actOnWriting(key, writing, offer: offer, state: &s, now: now)
        }

        switch (key, surface) {
        case (.tab, .ghost), (.tab, .alternatives), (.tab, .ghostFill):
            return take(Choice(candidate: s.ui.candidate))
        case (.tab, _):
            return takeAction(spec?.actions.first { $0.key == .tab } ?? offer.kind.actionLine?.primary)
        case (.optionRight, _):
            return take(Choice(candidate: s.ui.candidate, wordOnly: true))

        case (.escape, .alternatives):
            // Back to the first candidate, list closed; the ghost stays (SURFACES.md section 2).
            return navigate { $0.open = false; $0.candidate = 0 }
        case (.escape, _):
            clearOffer(&s)
            return .closeOffer(offerID: offer.id)

        case (.down, .ghost(let count)):
            return navigate { $0.open = true; $0.candidate = 1 % count }
        case (.down, .alternatives(let count)):
            return navigate { $0.candidate = ($0.candidate + 1) % count }
        case (.up, .alternatives(let count)):
            return navigate { $0.candidate = ($0.candidate + count - 1) % count }
        case (.down, .actionLine):
            // A pop-up drawn as its compact line: ↓ opens the full card, highlight as it was. Lead
            // decision (A14): the card it opens may cover something, placed where it covers least
            // (`FieldPanelPlacement.choose`), because the user asked to see it and Esc closes it.
            // Caret never covers a label on its own; only this key opens a card with no clear spot.
            if case .popup = offer.kind { return navigate { $0.compact = false } }
            return navigate { ui in
                ui.expanded = true
                ui.highlight = offer.kind.actionLine?.variants?.choices?.selected ?? 0
            }
        case (.down, .popup) where rows > 0:
            return navigate { $0.highlight = (($0.highlight ?? 0) + 1) % rows }
        case (.up, .popup) where rows > 0:
            return navigate { $0.highlight = (($0.highlight ?? 0) + rows - 1) % rows }
        case (.down, .popup):
            return takeAction(spec?.actions.first { $0.key == .down })

        case (.commandDigit(let n), .alternatives):
            return navigate { $0.candidate = n - 1 }
        case (.commandDigit(let n), .popup) where n <= rows:
            return navigate { $0.highlight = n - 1 }
        case (.commandDigit(1), .ghostFill):
            return take(Choice(fillAll: true))
        case (.commandDigit(let n), _):
            let actions = spec?.actions ?? offer.kind.actionLine?.actions ?? []
            guard let action = actions.first(where: { $0.key.digit == n }) else { return .pass(.noOffer) }
            return takeAction(action)

        default:
            // Unreachable while `KeyOwnership` and this switch agree; pass rather than swallow.
            return .pass(.noOffer)
        }
    }

    /// An owned key on a writing offer: `WritingOffer.send` decides, and the offer keeps its new
    /// state (open, the highlighted row) in the slot, mirrored into `OfferUI` for the drawing.
    private static func actOnWriting(_ key: KeyClass, _ writing: WritingOffer, offer: Offer, state s: inout State, now: Date) -> Decision {
        let event: WritingOffer.Event
        switch key {
        case .tab: event = .tab
        case .down: event = .down
        case .up: event = .up
        case .escape: event = .escape
        case .commandDigit(let n): event = .commandDigit(n)
        default: return .pass(.noOffer)
        }
        var next = writing
        let effect = next.send(event)
        var updated = offer
        updated.kind = .writing(next)
        switch effect {
        case .handled:
            s.current = updated
            s.ui.open = next.presentation == .expanded
            s.ui.candidate = next.current
            return .navigate(offerID: offer.id, ui: s.ui)
        case .apply:
            return .consume(claim(updated, choice: Choice(candidate: next.current, expanded: next.presentation == .expanded), state: &s, now: now))
        case .keepOriginal:
            // Original changes nothing and records no undo (`action-engine-v2.md` section 7).
            s.keptOriginalOfferID = offer.id
            clearOffer(&s)
            return .closeOffer(offerID: offer.id)
        case .dismiss:
            clearOffer(&s)
            return .closeOffer(offerID: offer.id)
        case .passThrough:
            // Unreachable while `KeyOwnership` and `WritingOffer.send` agree; pass rather than swallow.
            return .pass(.noOffer)
        }
    }

    /// Whether `incoming` may take the slot from `current`. When either is a writing offer, in
    /// `WritingOffer.incomingWins` order: a correction line takes the slot from ghost text, ghost
    /// text cannot take it from a correction line, and nothing but an explicit request replaces
    /// a list the user is moving through. Offers from the helper rank as an explicit request: the
    /// helper has already judged them worth the slot, and the host has no message to refuse one
    /// it was sent. Between two other offers the newer wins, as before writing existed.
    static func mayReplace(_ current: Offer, ui: OfferUI, with incoming: Offer) -> Bool {
        guard current.kind.writing != nil || incoming.kind.writing != nil else { return true }
        return WritingOffer.incomingWins(producer(of: incoming), over: slot(of: current, ui: ui))
    }

    static func producer(of offer: Offer) -> WritingOffer.Producer {
        switch offer.kind {
        case .writing(let writing): return writing.producer
        case .ghost: return .completion
        case .fill, .action, .popup: return .explicitRequest
        }
    }

    static func slot(of offer: Offer, ui: OfferUI) -> WritingOffer.Slot {
        switch offer.kind {
        case .writing(let writing): return writing.slot
        case .ghost: return WritingOffer.Slot(producer: .completion, holdsKeys: true, navigating: ui.open)
        case .fill, .action, .popup: return WritingOffer.Slot(producer: .explicitRequest, holdsKeys: true, navigating: false)
        }
    }

    private static func claim(_ offer: Offer, choice: Choice, state s: inout State, now: Date) -> Claim {
        var chosen = offer
        var typed = s.typedSinceOffer
        if case .ghost = offer.kind, offer.candidates.indices.contains(choice.candidate) {
            if choice.candidate != 0 { typed = "" }
            chosen.text = offer.candidates[choice.candidate]
            if choice.wordOnly {
                chosen.text = typed + nextWord(String(chosen.text.dropFirst(typed.count)))
            }
        }
        let claim = Claim(claimID: s.nextClaimID, offer: chosen, typedSinceOffer: typed, claimedAt: now, choice: choice)
        s.nextClaimID &+= 1
        clearOffer(&s)
        s.claimCount &+= 1
        s.lastClaim = ClaimRecord(
            claimID: claim.claimID,
            offerID: offer.id,
            claimedAt: now,
            insertionLength: claim.insertsText ? claim.insertionText.count : 0,
            outcome: claim.insertsText ? .pending : .accepted,
            candidate: offer.kind.name == "ghost" || offer.kind.writing != nil ? choice.candidate : nil,
            actionID: choice.actionID,
            row: choice.row,
            wordOnly: choice.wordOnly ? true : nil
        )
        if claim.insertsText {
            s.insertingClaimID = claim.claimID
            s.consumedTarget = nil
        }
        return claim
    }

    private static func clearOffer(_ s: inout State) {
        s.current = nil
        s.typedSinceOffer = ""
        s.ui = OfferUI()
    }

    /// Leading spaces, then one word: what ⌥→ takes (`OPEN-QUESTIONS.md` 4, pick a; the key moved
    /// from Shift+Tab in A18).
    static func nextWord(_ text: String) -> String {
        let leading = text.prefix { $0.isWhitespace }
        let word = text.dropFirst(leading.count).prefix { !$0.isWhitespace }
        return String(leading + word)
    }

    /// The surface an offer shows in its navigation state.
    static func surface(of offer: Offer, ui: OfferUI, typed: String) -> Surface {
        switch offer.kind {
        case .ghost:
            if ui.open { return .alternatives(count: offer.candidates.count) }
            // Once the user has typed into the top candidate, the others no longer fit the field.
            return .ghost(candidates: typed.isEmpty ? offer.candidates.count : 1)
        case .fill(let origin):
            return .ghostFill(fillAll: origin.fillAll)
        case .action(let line):
            if ui.expanded, let variants = offer.visibleSpec(ui: ui) {
                return .popup(rows: variants.rowCount, numbered: variants.numberedDigits, hasDown: variants.hasDownAction)
            }
            return .actionLine(numbered: Set(line.actions.compactMap(\.key.digit)), hasVariants: line.variants != nil)
        case .writing(let writing):
            switch writing.presentation {
            case .mark: return .nothing
            case .line: return .writingLine(tabFixes: writing.ownsTab)
            case .expanded: return .writingList(rows: writing.alternatives.count)
            }
        case .popup:
            // As its compact line it keys as an action line whose ↓ opens the card: Tab takes the
            // primary action, and no row or Command-digit is owned while none is visible.
            if ui.compact { return .actionLine(numbered: [], hasVariants: true) }
            let spec = offer.visibleSpec(ui: ui) ?? PopupSpec(id: "", figure: .offering, blocks: [])
            return .popup(rows: spec.rowCount, numbered: spec.numberedDigits, hasDown: spec.hasDownAction)
        }
    }

    // MARK: - Insertion queue

    /// Checks a claim against a fresh read of the field. A rejection ends the claim; nothing is
    /// inserted.
    public func confirm(
        _ claim: Claim,
        live: InsertionGuard.LiveField,
        now: Date = Date()
    ) -> Result<InsertionGuard.ApprovedEdit, InsertionGuard.Rejection> {
        let result: Result<InsertionGuard.ApprovedEdit, InsertionGuard.Rejection>
        if let edit = claim.edit() {
            result = InsertionGuard.approve(
                edit: edit,
                live: live,
                createdAt: claim.offer.createdAt,
                now: now,
                maxAgeSeconds: claim.offer.maxAgeSeconds
            )
        } else {
            result = .failure(.rangeSplitsCharacter(start: claim.offer.caretUTF16, end: claim.offer.caretUTF16))
        }
        state.withLock { s in
            switch result {
            case .success:
                s.consumedTarget = live.target
                Self.setOutcome(.approved, claimID: claim.claimID, in: &s)
            case .failure(let rejection):
                Self.setOutcome(.rejected(rejection.code), claimID: claim.claimID, in: &s)
                if s.insertingClaimID == claim.claimID { s.insertingClaimID = nil }
            }
        }
        return result
    }

    /// Checks a writing claim's range edit against a fresh read of the field, before anything is
    /// selected or written. A refusal ends the claim; nothing is written.
    public func confirmRange(_ claim: Claim, live: RangeEdit.Live, now: Date = Date()) -> Result<RangeEdit.Approved, RangeEdit.Refusal> {
        let result: Result<RangeEdit.Approved, RangeEdit.Refusal> = claim.rangeEdit.map { $0.validate(live, phase: .observed, now: now) }
            ?? .failure(.approvalMismatch)
        state.withLock { s in
            switch result {
            case .success:
                s.consumedTarget = live.target
                Self.setOutcome(.approved, claimID: claim.claimID, in: &s)
            case .failure(let refusal):
                Self.setOutcome(.rejected(refusal.code), claimID: claim.claimID, in: &s)
                if s.insertingClaimID == claim.claimID { s.insertingClaimID = nil }
            }
        }
        return result
    }

    /// Ends a claim that was refused before the guard ran (the target app is no longer allowed,
    /// the field cannot be read, a fill's source is gone). Nothing was written.
    public func abandon(claimID: UInt64, reason: String) {
        state.withLock { s in
            Self.setOutcome(.rejected(reason), claimID: claimID, in: &s)
            if s.insertingClaimID == claimID { s.insertingClaimID = nil }
        }
    }

    /// Ends an approved claim. Offers are accepted again afterwards, except for the revision the
    /// insertion consumed.
    public func finishInsertion(claimID: UInt64, error: String?) {
        state.withLock { s in
            Self.setOutcome(error.map(ClaimOutcome.insertFailed) ?? .inserted, claimID: claimID, in: &s)
            if s.insertingClaimID == claimID { s.insertingClaimID = nil }
        }
    }

    // MARK: - Inspection

    public func snapshot() -> Snapshot {
        state.withLock { s in
            Snapshot(
                current: s.current,
                typedSinceOffer: s.typedSinceOffer,
                lastClaim: s.lastClaim,
                insertingClaimID: s.insertingClaimID,
                toast: s.toast,
                statusLine: s.statusLine,
                ui: s.ui,
                publishedCount: s.publishedCount,
                claimCount: s.claimCount,
                refusedPublishCount: s.refusedPublishCount,
                keptOriginalOfferID: s.keptOriginalOfferID
            )
        }
    }

    private static func setOutcome(_ outcome: ClaimOutcome, claimID: UInt64, in s: inout State) {
        guard s.lastClaim?.claimID == claimID else { return }
        s.lastClaim?.outcome = outcome
    }
}
