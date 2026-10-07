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
/// described and left; one that reads as before needs no line.
extension SurfaceMachine {
    public func inlineInsertionFinished(_ r: InlineInsertion) {
        let recovery = r.recovery
        let text: String
        var hints: [Hint] = []
        switch recovery.state {
        case .original:
            return count("surface.inline.unconfirmed.original")
        case .whole, .partial:
            guard r.undo != nil else { return }
            if case .partial = recovery.state { text = "Only part of the text went in." } else { text = "Caret couldn't confirm the text, but the field holds it." }
            hints = [Hint(key: "⌘Z", label: "Undo")]
        case .unrecognized:
            guard let says = recovery.says else { return }
            text = FillMachine.sentence(says)
        }
        count("surface.inline.unconfirmed.\(recovery.name)")
        // Work on the panel keeps it; the field shows the user what it holds.
        guard work == nil else { return count("surface.inline.unconfirmed.busy") }
        if let shown { arbiter.invalidate(offerID: shown.offerID) }
        displacedShown = nil
        clear(exit: 0)
        endResult()
        lineSuppressed = false
        let line = WorkLine(LineContent(figure: .error, text: text, emphasis: .plain, hints: hints), text: text)
        let target = r.claim.offer.target
        var anchor: Anchor?
        if !headless, let field = world.focusedField(pid: target.pid), case .at(let caret) = world.caret(of: field) {
            anchor = Anchor(field: field.frame ?? caret, caret: caret)
        }
        let taskID = "inline-\(r.claim.claimID)"
        result = Result(taskID: taskID, target: target, anchor: anchor, line: line)
        var lifetime = FillMachine.errorLifetime
        if hints.isEmpty == false, let grant = r.undo {
            let id = arbiter.showToast(grant)
            toastGrantID = id
            emit(.toastSlotTaken)
            lifetime = grant.lifetimeSeconds
        }
        toastInfo = DebugState.Toast(kind: "error", caption: text, grantID: toastGrantID)
        lineText = text
        figure = line.content.figure
        if let anchor, !headless {
            showPanel(.line(line.content), text: text, placement: .atField(field: anchor.field, caret: anchor.caret, pid: target.pid, entering: true))
            startWatch(.line, target: target, anchors: [CGPoint(x: anchor.caret.midX, y: anchor.caret.midY)], requireFocus: false, field: anchor.field)
        }
        cancelResultTimer()
        let grantID = toastGrantID
        resultTimer = clock.schedule(after: lifetime, repeats: false) { [weak self] in
            guard let self, self.result?.taskID == taskID, self.toastGrantID == grantID else { return }
            self.resultTimer = nil
            self.endResult()
            self.takeLineDown(exit: 0.20)
            self.publish()
        }
        publish()
    }

    /// ⌘Z took the inline line's grant; the insertion queue runs the undo.
    func inlineUndoStarted(_ grant: UndoGrant) {
        guard let id = toastGrantID, id == grant.id else { return }
        toastGrantID = nil
        inlineUndo = grant.id
        toastInfo = DebugState.Toast(kind: "undoing", caption: WorkLines.undoing.text, grantID: nil)
        showResult(WorkLines.undoing, lifetime: 10)
    }

    /// The insertion queue's answer to the inline line's ⌘Z.
    public func inlineUndoFinished(grantID: UInt64, ok: Bool, error: String?, partial: Bool, says: String?) {
        guard inlineUndo == grantID else { return }
        inlineUndo = nil
        let text: String
        switch (ok, error) {
        case (true, _): text = partial ? "Took out the part that went in" : "Undone"
        case (false, UndoGuard.Rejection.nothingWritten.code?): text = "The field already reads as it did before."
        case (false, UndoGuard.Rejection.inputDuringUndo.code?): text = "You typed as Caret was undoing, so Caret left the field as it is."
        default: text = says.map(FillMachine.sentence) ?? "The field changed after Caret wrote it, so Caret left it as it is."
        }
        let line = WorkLine(LineContent(figure: ok ? .still : .error, text: text, emphasis: .plain), text: text)
        toastInfo = DebugState.Toast(kind: ok ? "undone" : "error", caption: text, grantID: nil)
        count("surface.inline.undo.\(ok ? (partial ? "partial" : "done") : "refused")")
        showResult(line, lifetime: ok ? 2 : FillMachine.errorLifetime)
    }
}
