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

    public init(offerKey: String, app: String, endState: PopupSpec.Value, actions: [PopupSpec.Action], variants: PopupSpec? = nil) {
        self.offerKey = offerKey
        self.app = app
        self.endState = endState
        self.actions = actions
        self.variants = variants
    }

    public var primary: PopupSpec.Action? { actions.first { $0.key == .tab } }
}

/// A pop-up offer: a validated spec and the helper's id for it.
public struct PopupOffer: Equatable, Sendable {
    public var offerKey: String
    public var spec: PopupSpec

    public init(offerKey: String, spec: PopupSpec) {
        self.offerKey = offerKey
        self.spec = spec
    }
}

extension PopupSpec {
    /// The spec after `actionID`'s reveal: its target block replaced and the revealing action gone
    /// from the bar. Unchanged when the action reveals nothing.
    public func applyingReveal(of actionID: String) -> PopupSpec {
        guard let action = actions.first(where: { $0.id == actionID }), let reveal = action.reveal else { return self }
        var copy = self
        copy.blocks = blocks.compactMap { block in
            if block.id == reveal.replace { return reveal.with }
            if case .actions(var bar) = block.content {
                bar.items.removeAll { $0.id == actionID }
                return Block(id: block.id, .actions(bar))
            }
            return block
        }
        return copy
    }

    /// Choice rows shown, which the arrows and Command-1 to 3 move between.
    public var rowCount: Int { choices?.rows.count ?? 0 }

    /// Command-digits bound to an action in the bar.
    public var numberedDigits: Set<Int> { Set(actions.compactMap(\.key.digit)) }

    public var hasDownAction: Bool { actions.contains { $0.key == .down } }
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
            return ui.expanded ? line.variants : nil
        case .ghost, .fill:
            return nil
        }
    }
}

/// A line that reports on work after Tab: working, then the result; or an error.
public struct StatusLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case working(startedAt: Date)
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

    public init(pid: Int32, kind: Kind, offerKey: String? = nil) {
        self.pid = pid
        self.kind = kind
        self.offerKey = offerKey
    }

    public func surface(at now: Date) -> Surface {
        switch kind {
        case .working(let started): return .working(stoppable: now.timeIntervalSince(started) >= Self.stoppableAfter)
        case .error: return .errorLine
        }
    }
}
