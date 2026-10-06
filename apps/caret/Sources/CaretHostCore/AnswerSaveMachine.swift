import CaretScreenCore
import CoreGraphics
import Foundation

/// The offer to keep an answer the user typed (S1's `answerSaveOffer`; brief H11): a quiet line under the
/// page field the user is in now, "Save this answer for next time?" with ⌘1 Save and Esc.
///
/// Quiet, and never in the way:
/// - It takes no Tab (`Surface.quietLine`). People move through a form with Tab; Tab saving their words would
///   be consent they never gave. ⌘1 saves, Esc dismisses, and any other key passes to the page and puts it away.
/// - It never takes the browser's keys from another offer: with one showing there, it is not shown at all.
/// - Nothing is saved without the ⌘1. The helper then checks the field again and says how it went.
/// Main thread only.
public final class AnswerSaveMachine {
    public enum Command: Equatable, Sendable {
        /// The line, under `field` (global, top-left points). `enters` on its first draw; `keyed` when a key made the
        /// change, which then draws at once with nothing moving (prep-for-prod H11-1).
        case draw(LineContent, field: CGRect, enters: Bool, keyed: Bool)
        /// At once when a key put it away; 220 ms when its time ran out.
        case hide(fade: Double)
        case send(AnswerSave)
        case count(String)
    }

    /// How long the offer waits for ⌘1. A guess, not measured: long enough to read one line after leaving
    /// the field, short enough that it is gone before the next field needs the space.
    public static let lifetime: Double = 10
    /// A saved answer's confirmation is shown this long (DIRECTION.md 5.3, "Undone": 2.5 s).
    public static let replyLifetime: Double = 2.5
    /// A refusal or a save nobody confirmed is information the user needs, so it stays as an error line does
    /// (DIRECTION.md 5.3, "Error": 6 s); any key still puts it away.
    public static let failureLifetime: Double = 6
    /// A save the helper never answers stops being awaited.
    public static let replyWait: Double = 4

    private let arbiter: OfferArbiter
    private let clock: SurfaceClock
    public var output: (Command) -> Void = { _ in }

    private var offer: AnswerSaveOffer?
    private var field: CGRect?
    private var offerID: UInt64?
    private var pendingRequest: String?
    private var timer: SurfaceTimer?
    private var requests = 0

    public init(arbiter: OfferArbiter, clock: SurfaceClock) {
        self.arbiter = arbiter
        self.clock = clock
    }

    /// The helper's offer, and the page field the user is in now in that page (`PageFocusBook`). Without a
    /// field to stand under, or with another offer holding the browser's keys, it is not shown.
    public func receive(_ o: AnswerSaveOffer, focus: PageField?) {
        guard let focus, focus.windowId == o.windowId, let frame = focus.frame, let pid = Int32(exactly: focus.app.pid), pid > 0 else {
            return output(.count("answerSave.noField"))
        }
        if let current = arbiter.snapshot().current, current.target.pid == pid {
            return output(.count("answerSave.yielded"))
        }
        clear(fade: 0)
        let line = ActionLine(offerKey: o.id, app: "", endState: PopupSpec.Value(o.says, ref: .memory(id: o.id)), actions: [PopupSpec.Action(id: "save", label: AnswerSaveCopy.save, key: .cmd1)])
        let target = TargetIdentity(pid: pid, bundleID: focus.app.bundleId, windowID: o.windowId, elementID: "answerSave:\(o.id)", elementRevision: "")
        // Published unshown, drawn, then revealed: ⌘1 can say yes only to a line on screen (review H11-1).
        guard let id = arbiter.publish(Offer(text: "", source: .helper, kind: .action(line), target: target, fieldValue: "", caretUTF16: 0, createdAt: clock.now, maxAgeSeconds: Self.lifetime), shown: false) else {
            return output(.count("answerSave.refused"))
        }
        offer = o
        offerID = id
        let rect = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        field = rect
        output(.count("answerSave.shown"))
        output(.draw(AnswerSaveCopy.offered(o), field: rect, enters: true, keyed: false))
        guard arbiter.reveal(offerID: id) else { return clear(fade: 0) }
        timer = clock.schedule(after: Self.lifetime, repeats: false) { [weak self] in
            guard let self, let id = self.offerID else { return }
            self.arbiter.invalidate(offerID: id)
            self.clear(fade: 0.22)
        }
    }

    /// ⌘1 took the offer: the user's yes goes to the helper, which saves only what they typed there.
    public func claimed(_ claim: Claim) {
        guard let id = offerID, claim.offer.id == id, let o = offer, claim.choice.actionID == "save" else { return }
        offerID = nil
        timer?.cancel()
        requests += 1
        let requestId = "answer-save-\(requests)"
        pendingRequest = requestId
        output(.send(AnswerSave(requestId: requestId, from: .offer(offerId: o.id))))
        output(.count("answerSave.yes"))
        if let field { output(.draw(AnswerSaveCopy.saving, field: field, enters: false, keyed: true)) }
        timer = clock.schedule(after: Self.replyWait, repeats: false) { [weak self] in
            guard let self, self.pendingRequest == requestId, let field = self.field else { return }
            self.pendingRequest = nil
            self.output(.draw(AnswerSaveCopy.unanswered, field: field, enters: false, keyed: false))
            self.leave(after: Self.failureLifetime)
        }
    }

    /// The helper's answer: saved, or why not, in its words.
    public func receive(_ reply: AnswerSaveReply) {
        guard let pending = pendingRequest, reply.requestId == pending, let field else { return }
        pendingRequest = nil
        timer?.cancel()
        output(.count(reply.outcome == .saved ? "answerSave.saved" : "answerSave.refused.\(reply.why ?? "unknown")"))
        output(.draw(AnswerSaveCopy.replied(reply), field: field, enters: false, keyed: false))
        leave(after: reply.outcome == .saved ? Self.replyLifetime : Self.failureLifetime)
    }

    /// A key put the offer away (Esc, typing, Tab to the next field), or its age did.
    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        guard let id = offerID, arbiter.snapshot().current?.id != id else { return }
        offerID = nil
        // A key put it away: gone at once, as every key-made change is.
        clear(fade: 0)
    }

    public func offerClosed(_ id: UInt64) {
        guard id == offerID else { return }
        offerID = nil
        clear(fade: 0)
    }

    /// Another offer took the browser's keys: the quiet line gives way at once.
    public func displaced(_ offer: Offer) {
        guard offer.id == offerID else { return }
        offerID = nil
        clear(fade: 0)
    }

    private func leave(after seconds: Double) {
        timer?.cancel()
        timer = clock.schedule(after: seconds, repeats: false) { [weak self] in self?.clear(fade: 0.22) }
    }

    private func clear(fade: Double) {
        timer?.cancel()
        timer = nil
        if let id = offerID { arbiter.invalidate(offerID: id) }
        let shown = offer != nil
        offer = nil
        offerID = nil
        pendingRequest = nil
        field = nil
        if shown { output(.hide(fade: fade)) }
    }
}

/// The save offer's words: the helper's sentence, the key's label, and the endings.
public enum AnswerSaveCopy {
    public static let save = "Save"

    public static func offered(_ o: AnswerSaveOffer) -> LineContent {
        LineContent(figure: .offering, text: o.says, emphasis: .plain, hints: [Hint(key: "⌘1", label: save), Hint(key: "Esc")])
    }

    public static let saving = LineContent(figure: .working, text: "Saving your answer", emphasis: .plain)
    public static let unanswered = LineContent(figure: .error, text: "Caret's helper didn't confirm the save, so it may not be kept.", emphasis: .plain)

    /// The helper's sentence: "Saved your answer to …" leads with Saved; a refusal is its reason.
    public static func replied(_ r: AnswerSaveReply) -> LineContent {
        switch r.outcome {
        case .saved:
            let rest = r.says.hasPrefix("Saved ") ? String(r.says.dropFirst("Saved ".count)) : r.says
            return LineContent(figure: .done, lead: r.says.hasPrefix("Saved ") ? "Saved" : nil, text: rest)
        case .refused:
            return LineContent(figure: .still, text: r.says, emphasis: .plain)
        }
    }
}
