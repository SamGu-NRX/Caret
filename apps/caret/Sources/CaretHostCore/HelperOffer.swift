import CaretScreenCore
import CoreGraphics
import Foundation

/// An offer the helper sent for one field: alternatives, an action line or a pop-up
/// (helper/src/protocol.ts, "offers to the host"). The host shows it only while that field has
/// focus, matched by frame because the host cannot recompute the reader's element keys.
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
    /// offer is for. An offer whose field has no frame matches nothing on screen.
    public func isFor(focusedFrame: CGRect?) -> Bool {
        guard let declared = field.frame, let focusedFrame else { return false }
        return FillSelection.matches(
            declared, Frame(x: focusedFrame.minX, y: focusedFrame.minY, width: focusedFrame.width, height: focusedFrame.height)
        )
    }

    /// How long the host keeps an offer the helper has not withdrawn. Assumed, not measured: the
    /// helper withdraws an offer whose window or values change, so this is only a backstop.
    public static let maxAgeSeconds: Double = 120

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
            kind = .popup(PopupOffer(offerKey: m.offerKey, spec: m.spec))
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

    /// What an undo restored, from an `undone` progress's detail.
    public struct UndoCount: Equatable, Sendable {
        public var restored: Int
        public var notRestored: Int

        public init(restored: Int, notRestored: Int) {
            self.restored = restored
            self.notRestored = notRestored
        }
    }

    /// Reads `restored N; not restored M; presses not undoable P`, the executor's undo detail
    /// (helper/src/executor/executor.ts, `undo`). Nil for any other text: the caption then says
    /// only that the undo finished. The protocol has no structured count yet (A5 report).
    public static func undoCount(_ detail: String?) -> UndoCount? {
        guard let detail else { return nil }
        let parts = detail.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 3,
              parts[0].hasPrefix("restored "), let restored = Int(parts[0].dropFirst("restored ".count)),
              parts[1].hasPrefix("not restored "), let notRestored = Int(parts[1].dropFirst("not restored ".count)),
              parts[2].hasPrefix("presses not undoable "), Int(parts[2].dropFirst("presses not undoable ".count)) != nil
        else { return nil }
        return UndoCount(restored: restored, notRestored: notRestored)
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
