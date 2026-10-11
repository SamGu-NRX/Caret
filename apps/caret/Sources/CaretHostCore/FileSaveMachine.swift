import CaretScreenCore
import Foundation

/// The offer to keep a file the user just attached (P3's `fileSaveOffer`; brief H14): a quiet line under the page
/// task panel, in the helper's words ("Use Robin Vale Resume.pdf for 'Resume' next time?"), with ⌘1 Save and Esc.
/// It works as the answer-save line does (`AnswerSaveMachine`):
/// - It takes no Tab (`Surface.quietLine`): moving on through the form never keeps a file. ⌘1 saves, Esc dismisses,
///   any other key passes to the page and puts it away.
/// - It never takes the browser's keys from another offer; with one showing there, it is not shown at all.
/// - Nothing is kept without the ⌘1. The helper answers with what it kept, or why not.
/// Main thread only.
public final class FileSaveMachine {
    /// Where the line stands: the page the file went into, by its browser.
    public struct Place: Equatable, Sendable {
        public var pid: Int32
        public var bundleId: String
        public var windowId: String

        public init(pid: Int32, bundleId: String, windowId: String) {
            self.pid = pid
            self.bundleId = bundleId
            self.windowId = windowId
        }
    }

    public enum Command: Equatable, Sendable {
        /// The line. `enters` on its first draw; `keyed` when a key made the change, which then draws at once.
        case draw(LineContent, enters: Bool, keyed: Bool)
        /// At once when a key put it away; 220 ms when its time ran out.
        case hide(fade: Double)
        case send(FileSave)
        /// The helper kept a file: the memory window's Files list is out of date.
        case saved
        case count(String)
    }

    /// The answer-save line's times, for the same kind of line (`AnswerSaveMachine`).
    public static let lifetime = AnswerSaveMachine.lifetime
    public static let replyLifetime = AnswerSaveMachine.replyLifetime
    public static let failureLifetime = AnswerSaveMachine.failureLifetime
    public static let replyWait = AnswerSaveMachine.replyWait

    private let arbiter: OfferArbiter
    private let clock: SurfaceClock
    public var output: (Command) -> Void = { _ in }

    private var offer: FileSaveOffer?
    private var offerID: UInt64?
    private var pendingRequest: String?
    private var timer: SurfaceTimer?
    private var requests = 0
    /// Shown, waiting for the helper, or showing its answer.
    public private(set) var phase: Phase = .none

    public enum Phase: String, Codable, Sendable { case none, offered, saving, answered }

    public init(arbiter: OfferArbiter, clock: SurfaceClock) {
        self.arbiter = arbiter
        self.clock = clock
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    /// The helper's offer, and where the page task panel for its goal is. Without that page, past its expiry, or with
    /// another offer holding the browser's keys, it is not shown.
    public func receive(_ o: FileSaveOffer, place: Place?) {
        guard let place else { return output(.count("fileSave.noPage")) }
        guard nowMs < o.expires else { return output(.count("fileSave.expired")) }
        if let current = arbiter.snapshot().current, current.target.pid == place.pid {
            return output(.count("fileSave.yielded"))
        }
        clear(fade: 0)
        let line = ActionLine(offerKey: o.id, app: "", endState: PopupSpec.Value(o.says, ref: .derived(rule: "fileSave", from: [])),
                              actions: [PopupSpec.Action(id: "save", label: FileSaveCopy.save, key: .cmd1)])
        let target = TargetIdentity(pid: place.pid, bundleID: place.bundleId, windowID: place.windowId, elementID: "fileSave:\(o.id)", elementRevision: "")
        let life = min(Self.lifetime, Double(o.expires - nowMs) / 1000)
        // Published unshown, drawn, then revealed: ⌘1 can say yes only to a line on screen (review H11-1).
        guard let id = arbiter.publish(Offer(text: "", source: .helper, kind: .action(line), target: target, fieldValue: "", caretUTF16: 0, createdAt: clock.now, maxAgeSeconds: life), shown: false) else {
            return output(.count("fileSave.refused"))
        }
        offer = o
        offerID = id
        phase = .offered
        output(.count("fileSave.shown"))
        output(.draw(FileSaveCopy.offered(o), enters: true, keyed: false))
        guard arbiter.reveal(offerID: id) else { return clear(fade: 0) }
        timer = clock.schedule(after: life, repeats: false) { [weak self] in
            guard let self, let id = self.offerID else { return }
            self.arbiter.invalidate(offerID: id)
            self.clear(fade: 0.22)
        }
    }

    /// ⌘1 took the offer: the user's yes goes to the helper.
    public func claimed(_ claim: Claim) {
        guard let id = offerID, claim.offer.id == id, let o = offer, claim.choice.actionID == "save" else { return }
        offerID = nil
        timer?.cancel()
        requests += 1
        let requestId = "file-save-\(requests)"
        pendingRequest = requestId
        phase = .saving
        output(.send(FileSave(requestId: requestId, offerId: o.id)))
        output(.count("fileSave.yes"))
        output(.draw(FileSaveCopy.saving, enters: false, keyed: true))
        timer = clock.schedule(after: Self.replyWait, repeats: false) { [weak self] in
            guard let self, self.pendingRequest == requestId else { return }
            self.pendingRequest = nil
            self.phase = .answered
            self.output(.draw(FileSaveCopy.unanswered, enters: false, keyed: false))
            self.leave(after: Self.failureLifetime)
        }
    }

    /// The helper's answer: kept, or why not, in its words.
    public func receive(_ reply: FileSaveReply) {
        guard let pending = pendingRequest, reply.requestId == pending else { return }
        pendingRequest = nil
        timer?.cancel()
        phase = .answered
        output(.count(reply.outcome == .saved ? "fileSave.saved" : "fileSave.refusedByHelper"))
        if reply.outcome == .saved { output(.saved) }
        output(.draw(FileSaveCopy.replied(reply), enters: false, keyed: false))
        leave(after: reply.outcome == .saved ? Self.replyLifetime : Self.failureLifetime)
    }

    /// A key put the offer away (Esc, typing, Tab), or its age did.
    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        guard let id = offerID, arbiter.snapshot().current?.id != id else { return }
        offerID = nil
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
        let shown = phase != .none
        offer = nil
        offerID = nil
        pendingRequest = nil
        phase = .none
        if shown { output(.hide(fade: fade)) }
    }
}

/// The save line's words: a short line, and under it the helper's sentence whole, on the question row that wraps
/// rather than cut it (as the Gmail line does, `PageInlineCopy.notice`). The helper's sentence names the file and the
/// question ("Use ines-vandermeer-resume-2026.pdf for 'Resume' next time?"), which one slip line cut on the test Mac.
public enum FileSaveCopy {
    public static let save = AnswerSaveCopy.save
    public static let attached = "File attached"

    public static func offered(_ o: FileSaveOffer) -> LineContent {
        LineContent(figure: .offering, text: attached, emphasis: .plain, question: .init(text: o.says, hints: [Hint(key: "⌘1", label: save), Hint(key: "Esc")]))
    }

    public static let saving = LineContent(figure: .working, text: "Keeping the file for next time", emphasis: .plain)
    public static let unanswered = LineContent(figure: .error, text: "Not confirmed", emphasis: .plain,
                                               question: .init(text: "Caret's helper didn't confirm it kept the file, so it may not be offered next time."))

    /// The helper's sentence, whole: "Caret will offer Robin Vale Resume.pdf for 'Resume' next time.", or why not.
    public static func replied(_ r: FileSaveReply) -> LineContent {
        LineContent(figure: r.outcome == .saved ? .done : .still, text: r.outcome == .saved ? "Kept for next time" : "Not kept", emphasis: .plain,
                    question: .init(text: r.says))
    }

    /// Everything the line says, the row under it included.
    public static func words(_ l: LineContent) -> String { [l.text, l.question?.text].compactMap { $0 }.joined(separator: " ") }
}
