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
        // The decoder refuses an empty list, but the type's initializer does not, and `offer` reads
        // the first candidate (CodeRabbit on PR #8).
        case .alternatives(let m):
            guard !m.candidates.isEmpty else { return nil }
            self = .alternatives(m)
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
        let event = EventCardCopy.isEvent(message)
        self.init(
            offerKey: message.offerKey, app: message.app, endState: message.endState,
            actions: message.actions, variants: message.variants.map { event ? EventCardCopy.card($0) : $0 }, eventCard: event
        )
    }
}

/// The host's words on the helper's event card (B16, `helper/src/offers/event-card.ts`).
///
/// The helper's card has a Calendar row naming the calendar the helper was started with ("Caret"),
/// which is not where the shipped app writes: the reader adds to the user's chosen or default
/// calendar (H8, `EventDestination`). So the host replaces that row, as an offer arrives, with its
/// own line under the time ("Adding to Work", `destined`), and drops the helper's row from any card
/// that arrives without one. With the line there, Tab says only "Add", as DIRECTION.md's card does;
/// without it, "Add to calendar". The helper's source block holds the sentence itself, which the
/// generic source line would draw as "from I'll grab coffee…", so it becomes a quoted Secondary row
/// with the same ref. Every other block is drawn as the helper sent it. An event offer is told by its
/// end state's ref, the helper's `eventCard` rule, not by the app name.
public enum EventCardCopy {
    public static let addLabel = "Add"
    /// Tab's label on a card that names no destination.
    public static let addToCalendarLabel = "Add to calendar"
    /// The helper's facts row that names its own calendar.
    static let calendarRowLabel = "Calendar"
    /// The rule on the host's destination line, which tells it apart from the helper's rows.
    public static let destinationRule = "calendarDestination"

    public static func isEvent(_ message: OfferAction) -> Bool {
        if case .derived(let rule, _) = message.endState.ref { return rule == "eventCard" }
        return false
    }

    /// The offer as it arrived, with its card's Calendar row replaced by the destination line
    /// (`EventCalendarCopy.cardLine`). Any other offer is returned as it is.
    public static func destined(_ message: OfferAction, line: String) -> OfferAction {
        guard isEvent(message), let spec = message.variants else { return message }
        var out = message
        out.variants = destinedSpec(spec, line: line)
        return out
    }

    /// The card with its Calendar row replaced by the destination line.
    public static func destinedSpec(_ card: PopupSpec, line: String) -> PopupSpec {
        var spec = card
        spec.blocks = spec.blocks.map { block in
            guard case .facts(var facts) = block.content else { return block }
            facts.rows = facts.rows.map { row in
                guard row.label == calendarRowLabel else { return row }
                let from: [PopupSpec.Ref]
                if case .derived(_, let sources) = row.value.ref { from = sources } else { from = [row.value.ref] }
                return PopupSpec.Facts.Row(value: PopupSpec.Value(line, ref: .derived(rule: destinationRule, from: from)), secondary: true)
            }
            var block = block
            block.content = .facts(facts)
            return block
        }
        return spec
    }

    /// The host's destination line on a card, if it has one.
    public static func destinationLine(_ spec: PopupSpec) -> String? {
        for block in spec.blocks {
            guard case .facts(let facts) = block.content else { continue }
            if let row = facts.rows.first(where: isDestination) { return row.value.text }
        }
        return nil
    }

    static func isDestination(_ row: PopupSpec.Facts.Row) -> Bool {
        if case .derived(let rule, _) = row.value.ref { return rule == destinationRule }
        return false
    }

    /// The card as drawn: the helper's own Calendar row gone, the sentence quoted, and Tab labelled.
    public static func card(_ spec: PopupSpec) -> PopupSpec {
        let named = destinationLine(spec) != nil
        var out = spec
        out.blocks = spec.blocks.compactMap { block in
            var block = block
            switch block.content {
            case .facts(var facts):
                facts.rows.removeAll { $0.label == calendarRowLabel }
                if facts.rows.isEmpty { return nil }
                block.content = .facts(facts)
            case .source(let source):
                let quoted = PopupSpec.Value("\u{201C}\(source.value.text)\u{201D}", ref: source.value.ref)
                block.content = .facts(PopupSpec.Facts(rows: [PopupSpec.Facts.Row(value: quoted, secondary: true)]))
            case .actions(var actions):
                actions.items = actions.items.map { item in
                    var item = item
                    if item.key == .tab { item.label = named ? addLabel : addToCalendarLabel }
                    return item
                }
                block.content = .actions(actions)
            default:
                break
            }
            return block
        }
        return out
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
        /// The run stopped. `reason` is the helper's (`TaskProgress.StopReason`), which the line
        /// names in plain words; `step` and `steps` place the stop, and `detail` is for the log only.
        case stopped(reason: TaskProgress.StopReason, step: Int?, steps: Int, detail: String?)
        /// The next step reads as send, submit, delete or pay; the press is left to the user. Or a
        /// calendar step needs what only the user can give (`blocked`, B16): Calendar access, or an
        /// On My Mac calendar account.
        /// `field`: a field it handed over instead of writing (B20, B23), when the detail names one.
        case handoff(blocked: CalendarBlock? = nil, field: HandedField? = nil)
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
        // The decoder refuses a stopped progress without a reason; `.error` only guards a helper
        // that skipped the decoder's check.
        case .stopped: return .stopped(reason: progress.stopReason ?? .error, step: progress.step, steps: progress.steps, detail: progress.detail)
        case .handoff: return .handoff(blocked: progress.blocked, field: HandedField.parse(progress.detail))
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

/// A field the helper handed to the user instead of writing it, read from the hand-off's detail.
/// Only the two sentences the helper writes for this (helper/src/executor/executor.ts) are read: B20's
/// "<App> did not take the text for the <Label> field[ while its window was in the background], so
/// Caret left it to you", and B23's "focus moved away from the <Label> field when Caret focused it,
/// so Caret did not write it; it is yours to fill". Any other detail gives nil, and the line says
/// only whose turn it is, so a changed sentence can lose the field's name but never put a wrong one
/// on screen.
public struct HandedField: Equatable, Sendable {
    public enum Why: Equatable, Sendable {
        /// The app took none of Caret's writes.
        case appDropped
        /// A page moved focus off the field when Caret focused it (WebKit, S1 audit #14).
        case focusMoved
    }

    /// The field's label, or nil for "this field".
    public var label: String?
    public var why: Why

    public init(label: String?, why: Why) {
        self.label = label
        self.why = why
    }

    /// Both sentences are anchored at both ends, so a label that holds the words around it ("Name
    /// field when Caret focused it") is read whole, and a cut-off sentence names nothing.
    public static func parse(_ detail: String?) -> HandedField? {
        guard let detail else { return nil }
        let moved = "focus moved away from ", movedEnd = " when Caret focused it, so Caret did not write it; it is yours to fill"
        if detail.hasPrefix(moved), detail.hasSuffix(movedEnd), detail.count > moved.count + movedEnd.count {
            return label(String(detail.dropFirst(moved.count).dropLast(movedEnd.count))).map { HandedField(label: $0, why: .focusMoved) }
        }
        // "<App> did not take the text for <field>": the field is what follows the last
        // " did not take the text for ", and must read "the <Label> field" or "this field".
        let tookEnd = ", so Caret left it to you", background = " while its window was in the background"
        guard detail.hasSuffix(tookEnd) else { return nil }
        var body = String(detail.dropLast(tookEnd.count))
        if body.hasSuffix(background) { body.removeLast(background.count) }
        let took = " did not take the text for "
        guard let start = body.range(of: took, options: .backwards) else { return nil }
        return label(String(body[start.upperBound...])).map { HandedField(label: $0, why: .appDropped) }
    }

    /// "the Name field" gives "Name", "this field" gives nil (the outer nil: not a field at all).
    private static func label(_ field: String) -> String?? {
        if field == "this field" { return .some(nil) }
        guard field.hasPrefix("the "), field.hasSuffix(" field") else { return nil }
        let name = String(field.dropFirst(4).dropLast(6)).trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : .some(name)
    }
}
