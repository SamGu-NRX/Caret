import Foundation

/// Virtual key codes this feature cares about. Named because a bare 48 in an
/// event-tap branch is unreadable and easy to get wrong.
enum InlineKeyCode {
    static let tab: Int64 = 48
    static let escape: Int64 = 53
    static let one: Int64 = 18
    static let two: Int64 = 19
    static let three: Int64 = 20
}

/// The modifier keys that change what a key means. Caps lock is deliberately
/// absent: Caps+Tab is still a plain Tab to the user, and treating it as
/// modified would silently stop completion for anyone with caps lock on.
struct InlineModifiers: OptionSet, Equatable {
    let rawValue: UInt64
    static let command = InlineModifiers(rawValue: 1 << 0)
    static let option = InlineModifiers(rawValue: 1 << 1)
    static let control = InlineModifiers(rawValue: 1 << 2)
    static let shift = InlineModifiers(rawValue: 1 << 3)

    var isEmpty: Bool { rawValue == 0 }
}

/// One keystroke as the tap sees it, with no CoreGraphics types, so the
/// decision below can be tested without an event tap or a running app.
struct InlineKeyEvent: Equatable {
    var keyCode: Int64
    var modifiers: InlineModifiers
    /// True for the synthetic repeats macOS sends while a key is held.
    var isAutorepeat: Bool
}

/// What the app does with a keystroke, and whether the host app still sees it.
///
/// `consumes` is the whole safety story for criterion 2 and 4: every case that
/// does not belong to Caret leaves it false, so Tab still indents, Shift-Tab
/// still moves focus backward and Cmd-1 still switches the host's tab.
enum InlineKeyDecision: Equatable {
    /// Not ours. The host app receives the key unchanged.
    case passThrough
    /// Accept the visible offer and swallow the physical key.
    case accept(proposalID: String)
    /// Take the preview down. The host still receives the key.
    case dismiss(reason: InlineCancelReason)
    /// Swallow a repeat of the key that already accepted, so one physical
    /// hold cannot indent the field after it completed.
    case swallowDuplicate
    /// Choose one of Caret's own visible action choices.
    case selectChoice(index: Int)
    /// Any other key while an offer is up: the user is typing or moving the
    /// caret, so the offer stops being about the current text.
    case cancelAndPassThrough(reason: InlineCancelReason)

    var consumesEvent: Bool {
        switch self {
        case .accept, .swallowDuplicate, .selectChoice: return true
        case .passThrough, .dismiss, .cancelAndPassThrough: return false
        }
    }
}

/// What the app currently has on screen, as far as key handling is concerned.
struct InlineKeyContext: Equatable {
    /// Proposal id of the offer the user can see right now, if any.
    var visibleProposalID: String?
    /// True once Tab has been accepted and the edit is still in flight.
    var acceptanceInFlight: Bool
    /// Number of action choices Caret is showing and owns. Zero means Cmd-1..3
    /// belong entirely to the host app.
    var visibleChoiceCount: Int
    /// False when permission, provider, secure-field or composition state says
    /// Caret must not intercept at all (criterion 5).
    var interceptionEnabled: Bool

    static let inert = InlineKeyContext(
        visibleProposalID: nil,
        acceptanceInFlight: false,
        visibleChoiceCount: 0,
        interceptionEnabled: false
    )
}

/// Decides who owns a keystroke. Pure: no AX calls, no network, no clock.
///
/// This runs inside the CGEvent tap callback, which the window server will
/// disable if it blocks. Keeping it a pure function over already-known state
/// is what makes that safe -- the tap never waits on a provider, it only reads
/// the last state the main thread published.
enum InlineKeyRouter {
    static func decide(_ event: InlineKeyEvent, context: InlineKeyContext) -> InlineKeyDecision {
        // Criterion 5: no permission, no provider, secure or excluded field,
        // unknown composition -> Caret is not in the keyboard path at all.
        guard context.interceptionEnabled else { return .passThrough }

        switch event.keyCode {
        case InlineKeyCode.tab:
            return decideTab(event, context: context)

        case InlineKeyCode.escape:
            guard event.modifiers.isEmpty, context.visibleProposalID != nil else { return .passThrough }
            // Dismiss but do not consume. Escape means "close this" in most
            // host apps too, and swallowing it would break that while gaining
            // nothing: the preview is already coming down.
            return .dismiss(reason: .escape)

        case InlineKeyCode.one, InlineKeyCode.two, InlineKeyCode.three:
            return decideChoice(event, context: context)

        default:
            // Typing or caret movement invalidates the offer immediately. The
            // key itself is never ours.
            guard context.visibleProposalID != nil else { return .passThrough }
            return .cancelAndPassThrough(reason: cancelReason(forKeyCode: event.keyCode))
        }
    }

    private static func decideTab(_ event: InlineKeyEvent, context: InlineKeyContext) -> InlineKeyDecision {
        // Any modifier makes it the host's Tab: Shift-Tab reverses focus,
        // Cmd-Tab switches apps, Ctrl-Tab cycles tabs. Caret only ever claims
        // the bare key.
        guard event.modifiers.isEmpty else { return .passThrough }

        if context.acceptanceInFlight {
            // The edit from the first Tab has not landed yet. Swallow the key
            // whether or not it is an autorepeat: a held Tab and a fast second
            // press are indistinguishable to the user, and neither should
            // indent a field that is about to be completed. The store refuses
            // the second acceptance regardless, so this only decides what the
            // host sees.
            return .swallowDuplicate
        }

        guard let proposalID = context.visibleProposalID else {
            // No offer on screen: Tab is the host's, untouched. This is the
            // common case and must stay the cheapest one.
            return .passThrough
        }

        // A held Tab that started before any offer existed must not accept an
        // offer that appeared underneath it.
        guard !event.isAutorepeat else { return .passThrough }

        return .accept(proposalID: proposalID)
    }

    private static func decideChoice(_ event: InlineKeyEvent, context: InlineKeyContext) -> InlineKeyDecision {
        // Exactly Command, nothing else: Cmd-Shift-1 and Cmd-Opt-1 stay the
        // host's, and the existing Cmd-Option pinned trigger keeps working.
        guard event.modifiers == [.command] else { return .passThrough }
        guard context.visibleChoiceCount > 0 else { return .passThrough }

        let index: Int
        switch event.keyCode {
        case InlineKeyCode.one: index = 0
        case InlineKeyCode.two: index = 1
        default: index = 2
        }
        // Cmd-3 with two choices showing is still the host's shortcut.
        guard index < context.visibleChoiceCount else { return .passThrough }
        return .selectChoice(index: index)
    }

    /// Arrow keys and clicks move the caret; anything else is typing. Both
    /// cancel, but they are worth telling apart in diagnostics.
    private static func cancelReason(forKeyCode keyCode: Int64) -> InlineCancelReason {
        switch keyCode {
        case 123, 124, 125, 126, 115, 119, 116, 121: return .caretMoved
        default: return .userTyped
        }
    }
}
