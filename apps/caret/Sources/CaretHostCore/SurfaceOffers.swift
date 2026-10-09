import CaretScreenCore
import Foundation

/// An action offer line: "▦ Calendar  Coffee with Dana, Thu 3:00 to 3:30  Tab".
public struct ActionLine: Equatable, Sendable {
    /// The helper's id for the offer, echoed in `offerAccept`.
    public var offerKey: String
    /// The app the action happens in, named by the line ("Calendar").
    public var app: String
    /// The end state in one sentence ("Coffee with Dana, Thu 3:00 to 3:30").
    public var endState: PopupSpec.Value
    /// The Tab action first; optional Command-digit actions after it.
    public var actions: [PopupSpec.Action]
    /// What the down arrow opens: a picker of variants ("Thu 3:00" against "Thu 15:00 to 15:45").
    public var variants: PopupSpec?
    /// A question about the run whose toast shows with it (a B19 keep or promote offer): Tab answers
    /// it and leaves the toast's ⌘Z in place; Esc declines it and closes both (`OfferArbiter`).
    public var answersToast: Bool
    /// The helper's event card (`EventCardCopy.isEvent`): accepting it may first ask for Calendar access.
    public var eventCard: Bool

    public init(offerKey: String, app: String, endState: PopupSpec.Value, actions: [PopupSpec.Action], variants: PopupSpec? = nil,
                answersToast: Bool = false, eventCard: Bool = false) {
        self.offerKey = offerKey
        self.app = app
        self.endState = endState
        self.actions = actions
        self.variants = variants
        self.answersToast = answersToast
        self.eventCard = eventCard
    }

    public var primary: PopupSpec.Action? { actions.first { $0.key == .tab } }
}

/// A pop-up offer: a validated spec and the helper's id for it.
public struct PopupOffer: Equatable, Sendable {
    public var offerKey: String
    public var spec: PopupSpec
    /// A grounded fill's source apps, each once, in field order (`OfferPopup.sourceApps`). The
    /// toast names these ("Filled 3 fields from Mail"), never the source block's "App, Title".
    public var sourceApps: [String]?
    /// H11: the page task panel's preview (`PageTaskMachine`), which draws itself. While it is current,
    /// no other producer's offer for the same browser takes its keys (`OfferArbiter.mayReplace`): all
    /// of a page's work stays in the one panel.
    public var pageTask: Bool

    public init(offerKey: String, spec: PopupSpec, sourceApps: [String]? = nil, pageTask: Bool = false) {
        self.offerKey = offerKey
        self.spec = spec
        self.sourceApps = sourceApps
        self.pageTask = pageTask
    }
}

/// Where the user is inside the current offer. Reset whenever a new offer is published.
public struct OfferUI: Equatable, Codable, Sendable {
    /// Index into `Offer.candidates`.
    public var candidate = 0
    /// Alternatives open (the down arrow was pressed).
    public var open = false
    /// The highlighted choice row of a pop-up.
    public var highlight: Int?
    /// The action whose reveal has been applied ("Change time").
    public var revealed: String?
    /// An action line opened into its variants picker.
    public var expanded = false
    /// No spot around the field showed the panel without covering one of the app's fields or
    /// labels, so the offer is drawn as the compact line (`CompactOffer`). For a pop-up, ↓ opens
    /// the full card and clears this; an action line's ↓ opens its variants as before.
    public var compact = false

    public init() {}

    init(initialFor offer: Offer) {
        self.init()
        if case .popup(let popup) = offer.kind { highlight = popup.spec.choices?.selected }
    }
}

extension OfferKind {
    public var actionLine: ActionLine? {
        if case .action(let line) = self { return line }
        return nil
    }
}

extension Offer {
    /// The pop-up as drawn in this navigation state: a pop-up offer after any reveal, or an action
    /// line opened into its variants. Nil for ghost text, fill and a closed action line.
    public func visibleSpec(ui: OfferUI) -> PopupSpec? {
        switch kind {
        case .popup(let popup):
            return ui.revealed.map { popup.spec.applyingReveal(of: $0) } ?? popup.spec
        case .action(let line):
            guard ui.expanded, let variants = line.variants else { return nil }
            return ui.revealed.map { variants.applyingReveal(of: $0) } ?? variants
        case .ghost, .fill, .writing:
            return nil
        }
    }
}

/// A line that reports on work after Tab: working, then the result; or an error.
public struct StatusLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case working(startedAt: Date)
        /// A result with nothing to undo ("Done, in Calendar", "Stopped"). Keys as the error line:
        /// Esc closes it, anything else passes and dismisses it. A result with an undo is the
        /// toast, held as an `UndoGrant`.
        case result
        case error
    }

    /// Esc stops work only after it has run this long; shorter work is not worth interrupting
    /// (`SURFACES.md` section 8).
    public static let stoppableAfter: TimeInterval = 3

    /// Assigned by `OfferArbiter.showStatus`.
    public internal(set) var id: UInt64 = 0
    public var pid: Int32
    public var kind: Kind
    /// The offer the work came from, for `stopWork`.
    public var offerKey: String?
    /// Esc takes over from the first moment, not after `stoppableAfter`: work a skill started with no
    /// Tab (B19) is one key from being handed back however short it is.
    public var takesOverAtOnce: Bool

    public init(pid: Int32, kind: Kind, offerKey: String? = nil, takesOverAtOnce: Bool = false) {
        self.pid = pid
        self.kind = kind
        self.offerKey = offerKey
        self.takesOverAtOnce = takesOverAtOnce
    }

    public var isWorking: Bool {
        if case .working = kind { return true }
        return false
    }

    public func surface(at now: Date) -> Surface {
        switch kind {
        case .working(let started): return .working(stoppable: takesOverAtOnce || now.timeIntervalSince(started) >= Self.stoppableAfter)
        case .error, .result: return .errorLine
        }
    }
}
