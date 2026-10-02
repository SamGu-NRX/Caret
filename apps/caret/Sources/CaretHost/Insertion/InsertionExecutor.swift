import AppCompatibility
import AutocompleteCore
import CaretHostCore
import Foundation
import os
import TextInsertion

/// Applies a claimed offer, off the tap thread and off the main thread.
///
/// For each claim, in order on one serial queue: reread the focused field (element, value,
/// selection, pid), let `OfferArbiter.confirm` run the insertion guard, and only then insert
/// through KeyType's `PasteboardCompletionInserter` (a synthesized ⌘V, which the target app's undo
/// records like a user paste). Afterwards it rereads until the field holds exactly the value the
/// guard predicted, and only then puts the user's clipboard back.
///
/// KeyType restores the clipboard on a fixed 120 ms timer, so an app that handles ⌘V later than
/// that pastes the user's own clipboard. Restoring only after the field shows the insertion (or
/// after `pasteSettleTimeout`) closes that window. No run has shown the late-paste case; one
/// TextEdit run on 2026-10-02 that first looked like it turned out to be unrelated text arriving
/// in the fixture. The cost is that the suggestion sits on the clipboard until the field settles.
final class InsertionExecutor: @unchecked Sendable {
    struct Result: Sendable {
        let claim: Claim
        let insertion: DebugState.Insertion
    }

    private let queue = DispatchQueue(label: "dev.caret.host.insertion", qos: .userInteractive)
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let planner: InsertionPlanner
    private let inserter: PasteboardCompletionInserter
    /// Shared with `inserter`, which saves the user's clipboard into it before writing.
    private let pasteboard = SystemPasteboard()
    private let pasteSettleTimeout: TimeInterval = 1.5
    private let onFinished: @Sendable (Result) -> Void
    /// The policy-relevant context of recent offers, so the planner can pick the app's insertion
    /// strategy (paste-and-match-style, NBSP workaround, chunked injection).
    private let contexts = OSAllocatedUnfairLock(initialState: [(UInt64, TextFieldContext)]())

    init(
        arbiter: OfferArbiter,
        status: HostStatus,
        compatibilityStore: AppCompatibilityStore,
        onFinished: @escaping @Sendable (Result) -> Void
    ) {
        self.arbiter = arbiter
        self.status = status
        self.planner = InsertionPlanner(compatibilityStore: compatibilityStore)
        self.inserter = PasteboardCompletionInserter(planner: planner, pasteboard: pasteboard, restoreDelayNanoseconds: 0)
        self.onFinished = onFinished
    }

    /// Main thread, when an offer is published.
    func remember(offerID: UInt64, context: TextFieldContext) {
        contexts.withLock { list in
            list.append((offerID, context))
            if list.count > 8 { list.removeFirst(list.count - 8) }
        }
    }

    /// Resumes once every claim submitted so far has finished, clipboard restore included.
    func waitUntilIdle() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { done.resume() }
        }
    }

    /// Tap thread. Only enqueues.
    func submit(_ claim: Claim) {
        queue.async { [self] in run(claim) }
    }

    private func run(_ claim: Claim) {
        let started = DispatchTime.now().uptimeNanoseconds
        let text = claim.insertionText
        func finish(ok: Bool, error: String?, verified: Bool?) {
            let insertion = DebugState.Insertion(
                claimID: claim.claimID,
                ok: ok,
                error: error,
                text: text,
                durationMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
                verified: verified
            )
            status.update { $0.lastInsertion = insertion }
            onFinished(Result(claim: claim, insertion: insertion))
        }

        guard let live = FieldReader.readFocused() else {
            arbiter.finishInsertion(claimID: claim.claimID, error: "fieldUnreadable")
            return finish(ok: false, error: "fieldUnreadable", verified: nil)
        }
        let approved: InsertionGuard.ApprovedEdit
        switch arbiter.confirm(claim, live: live.liveField) {
        case .failure(let rejection):
            return finish(ok: false, error: rejection.code, verified: nil)
        case .success(let edit):
            approved = edit
        }

        let context = contexts.withLock { list in list.last { $0.0 == claim.offer.id }?.1 }
            ?? TextFieldContext(beforeCursor: "", target: AppTarget(bundleIdentifier: claim.offer.target.bundleID, appName: ""))
        var plan = planner.plan(candidate: CompletionCandidate(text: text), context: context)
        let usesPasteboard: Bool
        switch plan.strategy {
        case .pasteboardPaste, .pasteAndMatchStyle, .firstWordOnly: usesPasteboard = true
        case .characterInjection, .chunkedStringInjection: usesPasteboard = false
        }
        plan.restorePasteboard = false
        let error = Self.blocking { [inserter] in try await inserter.insert(plan: plan) }
        let verified = error == nil ? waitForValue(approved.resultingValue, timeout: pasteSettleTimeout) : nil
        if usesPasteboard { pasteboard.restore() }
        arbiter.finishInsertion(claimID: claim.claimID, error: error)
        finish(ok: error == nil, error: error, verified: verified)
    }

    /// Polls the focused field for up to `timeout` until it holds `expected`. Apps apply a paste
    /// asynchronously, so a single immediate read would race it.
    private func waitForValue(_ expected: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if FieldReader.readFocused()?.value == expected { return true }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < deadline
        return false
    }

    /// Runs async insertion to completion on this serial queue, so the next claim cannot start
    /// before the paste and pasteboard restore have finished.
    private static func blocking(_ work: @escaping @Sendable () async throws -> Void) -> String? {
        let done = DispatchSemaphore(value: 0)
        let failure = OSAllocatedUnfairLock<String?>(initialState: nil)
        Task.detached(priority: .userInitiated) {
            do { try await work() } catch { failure.withLock { $0 = String(describing: error) } }
            done.signal()
        }
        done.wait()
        return failure.withLock { $0 }
    }
}
