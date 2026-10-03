import CaretScreenCore
import CoreGraphics
import Foundation

/// An offer the helper sent for one field: alternatives, an action line or a pop-up
/// (helper/src/protocol.ts, "offers to the host"). The host shows it only while that field has
/// focus, matched by frame because the host cannot recompute the reader's element keys, and by the
/// window the reader names (`FieldMatch`).
public enum HelperOffer: Equatable, Sendable {
    case alternatives(OfferAlternatives)
    case action(OfferAction)
    case popup(OfferPopup)

    public init?(_ inbound: HelperInbound) {
        switch inbound {
        case .alternatives(let m): self = .alternatives(m)
        case .action(let m): self = .action(m)
        case .popup(let m): self = .popup(m)
        default: return nil
        }
    }

    public var offerKey: String {
        switch self {
        case .alternatives(let m): return m.offerKey
        case .action(let m): return m.offerKey
        case .popup(let m): return m.offerKey
        }
    }

    public var field: OfferField {
        switch self {
        case .alternatives(let m): return m.field
        case .action(let m): return m.field
        case .popup(let m): return m.field
        }
    }

    /// The field's window as the reader read it: the window server's number and the title.
    public var window: WindowIdentity { WindowIdentity(field.window) }

    /// Nil when the helper named a pid that is not a process id.
    public var pid: Int32? { Int32(exactly: field.pid).flatMap { $0 > 0 ? $0 : nil } }

    /// The `OfferKind` name the arbiter will hold it as.
    public var kindName: String {
        switch self {
        case .alternatives: return "ghost"
        case .action: return "action"
        case .popup: return "popup"
        }
    }

    /// The texts of the alternatives, best first. Empty for an action line or a pop-up.
    public var candidateTexts: [String] {
        if case .alternatives(let m) = self { return m.candidates.map(\.text) }
        return []
    }

    /// The top alternative is quoted from a source on screen, so it carries the uneven underline.
    public var quoted: Bool {
        if case .alternatives(let m) = self { return m.quoted }
        return false
    }

    /// Whether the focused element at `focusedFrame` (global, top-left points) is the field this
    /// offer is for. An offer whose field has no frame matches nothing on screen. With a window
    /// named on both sides, it must agree too (`FieldMatch`).
    public func isFor(focusedFrame: CGRect?, declaredWindow: WindowIdentity? = nil, focusedWindow: WindowIdentity? = nil) -> Bool {
        FieldMatch.matches(declaredFrame: field.frame, declaredWindow: declaredWindow, focusedFrame: focusedFrame, focusedWindow: focusedWindow)
    }

    /// The host puts no age limit of its own on a helper offer. The helper ends every offer it
    /// makes: a timed one with `offerWithdrawn expired` (2 to 10 min, helper/src/offers/lifetimes.ts)
    /// and the others on an event (Open when the user visits the window, a fill pop-up when focus
    /// leaves the form). The 120 s backstop this replaced made Tab pass through a routine the helper
    /// still offered. An offer whose helper goes away is taken down instead (`helperGone`).
    public static let maxAgeSeconds: Double = .infinity

    /// What the arbiter holds for this offer, bound to the field as the host read it.
    public func offer(target: TargetIdentity, fieldValue: String, caretUTF16: Int, createdAt: Date = Date()) -> Offer {
        let kind: OfferKind
        var text = ""
        var more: [String] = []
        switch self {
        case .alternatives(let m):
            // The host inserts the text itself, as it does ghost text; there is no offerAccept.
            kind = .ghost
            text = m.candidates[0].text
            more = m.candidates.dropFirst().map(\.text)
        case .action(let m):
            kind = .action(ActionLine(m))
        case .popup(let m):
            kind = .popup(PopupOffer(offerKey: m.offerKey, spec: m.spec, sourceApps: m.sourceApps))
        }
        return Offer(
            text: text, moreCandidates: more, source: .helper, kind: kind, target: target,
            fieldValue: fieldValue, caretUTF16: caretUTF16, createdAt: createdAt, maxAgeSeconds: Self.maxAgeSeconds
        )
    }

    /// The field as the helper names it, for a host that reads no field and draws nothing
    /// (`--surfaces headless`). The element id is the reader's key; the revision is that of an
    /// empty field, since the host has not read the value.
    public var declaredTarget: TargetIdentity {
        TargetIdentity(
            pid: pid ?? 0, bundleID: "", windowID: field.windowId, elementID: field.key, elementRevision: UTF16Text.digest("")
        )
    }
}

extension ActionLine {
    public init(_ message: OfferAction) {
        self.init(
            offerKey: message.offerKey, app: message.app, endState: message.endState,
            actions: message.actions, variants: message.variants
        )
    }
}

/// What the helper's later messages do to an offer the host holds, shows or is working on. Pure,
/// so each rule has its own test; `SurfaceCoordinator` applies the result.
public enum OfferLifecycle {
    public struct Withdrawal: Equatable, Sendable {
        /// Take down the shown offer: the user has not taken it yet.
        public var removeShown = false
        /// Forget the offer held for its field to come into view.
        public var dropHeld = false

        public init(removeShown: Bool = false, dropHeld: Bool = false) {
            self.removeShown = removeShown
            self.dropHeld = dropHeld
        }
    }

    /// `offerWithdrawn` removes the offer with that key wherever it waits. Work already accepted
    /// from it is not affected: the helper withdraws an offer as `taken` once its run starts.
    public static func withdrawal(of id: String, shownKey: String?, heldKey: String?) -> Withdrawal {
        Withdrawal(removeShown: shownKey == id, dropHeld: heldKey == id)
    }

    /// How the working line for an accepted offer ends.
    public enum Ending: Equatable, Sendable {
        case done
        /// A recheck, mismatch or failure stopped the run; `detail` says why, for the log only.
        case stopped(detail: String?)
        /// The next step reads as send, submit, delete or pay; the press is left to the user.
        case handoff
        /// Real input in the target window paused the run. The activity list carries it from here.
        case paused
        /// No helper to run it: `offerAccept` could not be written, or the connection dropped
        /// before the run reported an end. Never from `ending(of:workKey:)`.
        case helperDown
    }

    /// The ending a task's progress brings to the working line for `workKey`, or nil while the run
    /// goes on or the progress is another task's. The work's task id is its offer's key.
    public static func ending(of progress: TaskProgress, workKey: String?) -> Ending? {
        guard let workKey, progress.taskId == workKey else { return nil }
        switch progress.phase {
        case .done: return .done
        case .stopped: return .stopped(detail: progress.detail)
        case .handoff: return .handoff
        case .paused: return .paused
        case .started, .skipped, .acting, .verified, .undone: return nil
        }
    }

    /// What an undo restored, from an `undone` progress's counts.
    public struct UndoCount: Equatable, Sendable {
        public var restored: Int
        public var notRestored: Int

        public init(restored: Int, notRestored: Int) {
            self.restored = restored
            self.notRestored = notRestored
        }
    }

    /// The counts an `undone` progress carries (`restored`, `notRestored`). Nil when it carries
    /// none: the caption then says only that the undo finished. The detail text is for people and
    /// is never parsed.
    public static func undoCount(_ progress: TaskProgress) -> UndoCount? {
        guard progress.phase == .undone, let restored = progress.restored, let notRestored = progress.notRestored else { return nil }
        return UndoCount(restored: restored, notRestored: notRestored)
    }

    /// The source apps as a toast names them: "Mail", "Mail and Notes", "Mail, Notes and Safari".
    /// Nil without any.
    public static func sourcePhrase(_ apps: [String]?) -> String? {
        guard let apps, let last = apps.last else { return nil }
        if apps.count == 1 { return last }
        return apps.dropLast().joined(separator: ", ") + " and " + last
    }
}

extension PopupSpec {
    /// A fill pop-up: its fields block lists the values Tab writes. Its result is a toast with undo.
    public var fillRows: Int? {
        for block in blocks {
            if case .fields(let fields) = block.content { return fields.rows.count + fields.more }
        }
        return nil
    }

    /// The source block's text ("Mail, Order confirmation").
    public var sourceText: String? {
        for block in blocks {
            if case .source(let source) = block.content { return source.value.text }
        }
        return nil
    }
}
