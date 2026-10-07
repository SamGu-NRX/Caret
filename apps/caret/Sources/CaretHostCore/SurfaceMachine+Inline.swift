import CoreGraphics
import Foundation

/// An inline text insert (ghost text, the engine's or the helper's) that Caret could not confirm,
/// and what a read of the field found afterwards (S2). The insertion queue arms its undo grant
/// before writing, as it does a fill's; `undo` is set when the field holds the whole text or a part.
public struct InlineInsertion: Equatable, Sendable {
    public var claim: Claim
    public var recovery: UnconfirmedInsert.Report
    public var undo: UndoGrant?

    public init(claim: Claim, recovery: UnconfirmedInsert.Report, undo: UndoGrant?) {
        self.claim = claim
        self.recovery = recovery
        self.undo = undo
    }
}

/// The line at the caret is the inline insert's result owner: inline text has no toast of its own,
/// so a recognized partial or whole write is reported here and ⌘Z belongs to Caret while the line
/// shows, as a fill's toast does (`SURFACES.md` section 6). A field Caret does not recognize is
/// described and left, on a result line that Esc and typing take down. One that reads as before
/// needs no line. Nothing is shown, and ⌘Z stays the host's, unless the line can be drawn at the
/// written field, in front and uncovered: a shortcut belongs to a visible offer or to the host.
extension SurfaceMachine {
    public func inlineInsertionFinished(_ r: InlineInsertion) {
        let recovery = r.recovery
        let text: String
        var grant: UndoGrant?
        switch recovery.state {
        case .original:
            return count("surface.inline.unconfirmed.original")
        case .whole, .partial:
            guard let g = r.undo else { return }
            grant = g
            if case .partial = recovery.state { text = "Only part of the text went in." } else { text = "Caret couldn't confirm the text, but the field holds it." }
        case .unrecognized:
            guard let says = recovery.says else { return }
            text = FillMachine.sentence(says)
        }
        count("surface.inline.unconfirmed.\(recovery.name)")
        // Work on the panel keeps it; the field shows the user what it holds.
        guard work == nil else { return count("surface.inline.unconfirmed.busy") }
        let target = r.claim.offer.target
        guard !headless, let field = world.focusedField(pid: target.pid),
              field.identity.elementID == target.elementID, field.identity.windowID == target.windowID,
              case .at(let caret) = world.caret(of: field),
              gate(target, anchors: [CGPoint(x: caret.midX, y: caret.midY)], requireFocus: true) == nil
        else { return count("surface.inline.unconfirmed.unseen") }
        let anchor = Anchor(field: field.frame ?? caret, caret: caret)
        if let shown { arbiter.invalidate(offerID: shown.offerID) }
        displacedShown = nil
        clear(exit: 0)
        endResult()
        lineSuppressed = false
        let line = WorkLine(
            LineContent(figure: .error, text: text, emphasis: .plain, hints: grant == nil ? [] : [Hint(key: "⌘Z", label: "Undo")]), text: text
        )
        let taskID = "\(Self.inlineTaskPrefix)\(r.claim.claimID)"
        result = Result(taskID: taskID, target: target, anchor: anchor, line: line)
        var lifetime = FillMachine.errorLifetime
        if let grant {
            // The toast slot is the ⌘Z: it goes with this line, and the line goes with it.
            toastGrantID = arbiter.showToast(grant)
            emit(.toastSlotTaken)
            lifetime = grant.lifetimeSeconds
        } else {
            // A result line with no ⌘Z still takes Esc, and typing on dismisses it.
            resultStatusID = arbiter.showStatus(StatusLine(pid: target.pid, kind: .error, offerKey: taskID))
        }
        toastInfo = DebugState.Toast(kind: "error", caption: text, grantID: toastGrantID)
        lineText = text
        figure = line.content.figure
        showPanel(.line(line.content), text: text, placement: .atField(field: anchor.field, caret: anchor.caret, pid: target.pid, entering: true))
        // Focus required: in another field or window of the app, the line describes a field the user left.
        startWatch(.line, target: target, anchors: [CGPoint(x: caret.midX, y: caret.midY)], requireFocus: true, field: anchor.field)
        cancelResultTimer()
        let grantID = toastGrantID
        let statusID = resultStatusID
        resultTimer = clock.schedule(after: lifetime, repeats: false) { [weak self] in
            guard let self, self.result?.taskID == taskID, self.toastGrantID == grantID, self.resultStatusID == statusID else { return }
            self.resultTimer = nil
            self.endResult()
            self.takeLineDown(exit: 0.20)
            self.publish()
        }
        publish()
    }

    /// ⌘Z took the inline line's grant; the insertion queue runs the undo.
    func inlineUndoStarted(_ grant: UndoGrant) {
        guard let id = toastGrantID, id == grant.id, let result else { return }
        toastGrantID = nil
        inlineUndo = (grant.id, result.taskID)
        holdStatus(.result, for: result)
        toastInfo = DebugState.Toast(kind: "undoing", caption: WorkLines.undoing.text, grantID: nil)
        showResult(WorkLines.undoing, lifetime: 10)
    }

    /// The line's status slot, for a state with no ⌘Z: Esc closes it and typing dismisses it, and
    /// either ends the result (`offerChanged`), pending undo included.
    func holdStatus(_ kind: StatusLine.Kind, for result: Result) {
        if let id = resultStatusID { arbiter.clearStatus(id: id) }
        resultStatusID = arbiter.showStatus(StatusLine(pid: result.target.pid, kind: kind, offerKey: result.taskID))
    }

    /// The insertion queue's answer to the inline line's ⌘Z. It may reach main before the tap's
    /// `undoStarted` (an immediate refusal): the line whose grant it is still owns it, and the late
    /// start then finds no grant to start. Drawn only while that line still owns the panel.
    public func inlineUndoFinished(grantID: UInt64, ok: Bool, error: String?, partial: Bool, says: String?) {
        let owner: String
        if let pending = inlineUndo, pending.grant == grantID {
            owner = pending.taskID
        } else if toastGrantID == grantID, let result {
            owner = result.taskID
            toastGrantID = nil
        } else {
            return
        }
        inlineUndo = nil
        guard let result, result.taskID == owner else { return }
        let text: String
        switch (ok, error) {
        case (true, _): text = partial ? "Took out the part that went in" : "Undone"
        case (false, UndoGuard.Rejection.nothingWritten.code?): text = "The field already reads as it did before."
        case (false, UndoGuard.Rejection.inputDuringUndo.code?): text = "You typed as Caret was undoing, so Caret left the field as it is."
        default: text = says.map(FillMachine.sentence) ?? "The field changed after Caret wrote it, so Caret left it as it is."
        }
        let line = WorkLine(LineContent(figure: ok ? .still : .error, text: text, emphasis: .plain), text: text)
        holdStatus(ok ? .result : .error, for: result)
        toastInfo = DebugState.Toast(kind: ok ? "undone" : "error", caption: text, grantID: nil)
        count("surface.inline.undo.\(ok ? (partial ? "partial" : "done") : "refused")")
        showResult(line, lifetime: ok ? 2 : FillMachine.errorLifetime)
    }
}
