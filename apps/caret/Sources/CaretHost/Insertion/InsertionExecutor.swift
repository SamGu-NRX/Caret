import AppCompatibility
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import Foundation
import os
import TextInsertion

/// Applies a claimed offer, and reverts a fill on ⌘Z, off the tap thread and off the main thread.
///
/// For each claim, in order on one serial queue:
///
/// 1. Reread the focused field of the offer's own pid (never the system-wide focused element, which
///    belongs to whatever app is in front).
/// 2. For a fill from a window, recheck that the source still shows the value (`SourceCheck`). A
///    fill from memory has no window to look in and skips this step only.
/// 3. Let `OfferArbiter.confirm` run the insertion guard against that reread.
/// 4. Write. By default KeyType's `PasteboardCompletionInserter` with a synthesizer that posts ⌘V to
///    the target's pid (`PidKeystrokeSynthesizer`). An app that leaves the field unchanged after a
///    pid paste gets an `AXSelectedText` write instead, and is remembered (`WriteMethodTable`).
/// 5. Reread until the field holds exactly the value the guard predicted, then put the user's
///    clipboard back.
///
/// The clipboard is restored only after the field settles, not on KeyType's fixed 120 ms timer, so
/// an app that reads the pasteboard late still pastes the suggestion and not the user's clipboard.
final class InsertionExecutor: @unchecked Sendable {
    struct Result: Sendable {
        let claim: Claim
        let insertion: DebugState.Insertion
        /// For a verified fill: what ⌘Z may revert while the toast is up.
        let undo: UndoGrant?
        /// Why the write did not happen or did not verify, as a `FillResult` reason code.
        let reason: String?
        let rejected: Bool
        let method: FillResult.Method?
    }

    struct UndoResult: Sendable {
        let grant: UndoGrant
        let ok: Bool
        let error: String?
    }

    private typealias Settle = WriteFallback.Settle

    private let queue = DispatchQueue(label: "dev.caret.host.insertion", qos: .userInteractive)
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let planner: InsertionPlanner
    private let policy: TargetPolicy
    let writeMethods = WriteMethodTable()
    /// Saves the user's clipboard before a paste and restores it after.
    private let pasteboard = SystemPasteboard()
    private let pasteSettleTimeout: TimeInterval = 1.5
    /// How long a pid paste may leave the field untouched before the app is judged to ignore it.
    /// Assumed, not measured across apps: TextEdit applied A1's pastes within one 20 ms poll.
    private let ignoredPasteAfter: TimeInterval = 0.5
    /// Move focus to the next field after a verified fill (SURFACES.md section 5).
    private let advanceAfterFill: Bool
    private let onFinished: @Sendable (Result) -> Void
    private let onUndone: @Sendable (UndoResult) -> Void
    /// Policy-relevant context of recent offers, so the planner can pick the app's insertion
    /// strategy (paste-and-match-style, NBSP workaround, chunked injection).
    private let contexts = OSAllocatedUnfairLock(initialState: [(UInt64, TextFieldContext)]())
    /// The element each recent fill wrote into, and its process's start time, by write id, so ⌘Z
    /// can reread exactly that element even after focus moved to the next field.
    private let written = OSAllocatedUnfairLock(initialState: [(UInt64, AXUIElement, UInt64)]())
    private let writeIDs = OSAllocatedUnfairLock(initialState: UInt64(0))

    init(
        arbiter: OfferArbiter,
        status: HostStatus,
        compatibilityStore: AppCompatibilityStore,
        policy: TargetPolicy,
        advanceAfterFill: Bool,
        onFinished: @escaping @Sendable (Result) -> Void,
        onUndone: @escaping @Sendable (UndoResult) -> Void
    ) {
        self.arbiter = arbiter
        self.status = status
        self.planner = InsertionPlanner(compatibilityStore: compatibilityStore)
        self.policy = policy
        self.advanceAfterFill = advanceAfterFill
        self.onFinished = onFinished
        self.onUndone = onUndone
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

    /// Tap thread or debug socket. Only enqueues.
    func submit(_ claim: Claim) {
        queue.async { [self] in run(claim) }
    }

    /// Tap thread or debug socket. Only enqueues.
    func submitUndo(_ grant: UndoGrant) {
        queue.async { [self] in runUndo(grant) }
    }

    // MARK: - Insert

    private func run(_ claim: Claim) {
        let started = DispatchTime.now().uptimeNanoseconds
        let text = claim.insertionText
        let pid = claim.offer.target.pid
        let origin = claim.offer.kind.fillOrigin

        func finish(
            ok: Bool, error: String?, verified: Bool?, method: FillResult.Method? = nil,
            fellBack: Bool = false, undo: UndoGrant? = nil, rejected: Bool = false, repaired: Bool = false
        ) {
            var insertion = DebugState.Insertion(
                claimID: claim.claimID, ok: ok, error: error, text: text,
                durationMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
                verified: verified
            )
            insertion.kind = claim.offer.kind.name
            insertion.method = method?.rawValue
            insertion.fellBack = fellBack
            insertion.repairedLatePaste = repaired
            status.update { $0.lastInsertion = insertion }
            onFinished(Result(claim: claim, insertion: insertion, undo: undo, reason: error, rejected: rejected, method: method))
        }
        func refuse(_ reason: String) {
            arbiter.abandon(claimID: claim.claimID, reason: reason)
            finish(ok: false, error: reason, verified: nil, rejected: true)
        }

        guard policy.allowsLive(pid: pid), let processStart = ProcessStart.of(pid) else { return refuse("targetNotAllowed") }
        // The source walk can take up to its deadline; the field is reread after it, so the guard
        // approves the field as it is immediately before the write.
        // A value from memory has no window to look in (`FillOrigin.Source.memory`); only a
        // window's value is rechecked there. Both still pass the field reread below.
        if case .window(let window)? = origin?.source {
            let source = SourceCheck.check(value: claim.offer.text, source: window)
            guard source == .present else { return refuse("source.\(source)") }
        }
        guard let reread = FieldReader.readFocused(pid: pid) else { return refuse("fieldUnreadable") }
        let (element, live) = reread
        let approved: InsertionGuard.ApprovedEdit
        switch arbiter.confirm(claim, live: live.liveField) {
        case .failure(let rejection):
            return finish(ok: false, error: rejection.code, verified: nil, rejected: true)
        case .success(let edit):
            approved = edit
        }

        let appKey = WriteMethodTable.appKey(pid: pid)
        // Checked before every event and AX write: the same process (not a new one reusing the
        // pid), still allowed, and the approved element still focused, since a pid-posted ⌘V goes
        // to whichever field of the app has focus.
        let stillTarget = { [policy] in
            ProcessStart.of(pid) == processStart && policy.allowsLive(pid: pid)
                && AXRead.focusedElement(pid: pid).map { CFEqual($0, element) } == true
        }
        var method: FillResult.Method
        var fellBack = false
        var repairedLatePaste = false
        var step: WriteFallback.Step

        if writeMethods.method(for: appKey) == .axSelectedText {
            method = .axSelectedText
            step = stillTarget() ? WriteFallback.afterAX(axWrite(approved, element: element, unchanged: live.value)) : .failed("targetNotAllowed")
        } else {
            method = .pastePid
            let synthesizer = PidKeystrokeSynthesizer(pid: pid, element: element, stillTarget: stillTarget)
            let inserter = PasteboardCompletionInserter(planner: planner, synthesizer: synthesizer, pasteboard: pasteboard, restoreDelayNanoseconds: 0)
            let context = contexts.withLock { list in list.last { $0.0 == claim.offer.id }?.1 }
                ?? TextFieldContext(beforeCursor: "", target: AppTarget(bundleIdentifier: claim.offer.target.bundleID, appName: ""))
            var plan = planner.plan(candidate: CompletionCandidate(text: text), context: context)
            let usesPasteboard: Bool
            switch plan.strategy {
            case .pasteboardPaste, .pasteAndMatchStyle, .firstWordOnly: usesPasteboard = true
            case .characterInjection, .chunkedStringInjection: usesPasteboard = false
            }
            plan.restorePasteboard = false
            let finalPlan = plan
            var postError = Self.blocking { try await inserter.insert(plan: finalPlan) }
            if synthesizer.refusedPosts > 0 { postError = "targetNotAllowed" }
            let settle: Settle = postError == nil ? waitForSettle(element: element, expected: approved, unchanged: live.value) : .different
            step = WriteFallback.afterPaste(settle, usedPasteboard: usesPasteboard, postError: postError)
            if step == .fallBackToAX {
                // The app ignored the pid paste. Empty the clipboard first, so a paste the app
                // processes after all inserts nothing rather than a second copy.
                pasteboard.write("")
                Thread.sleep(forTimeInterval: 0.05)
                if FieldReader.read(element)?.value == live.value, stillTarget() {
                    method = .axSelectedText
                    fellBack = true
                    writeMethods.record(.axSelectedText, for: appKey)
                    step = WriteFallback.afterAX(axWrite(approved, element: element, unchanged: live.value))
                } else {
                    step = .failed("writeMismatch")
                }
            }
            if fellBack, step == .verified,
               let duplicate = WriteFallback.lateDuplicate(original: live.value, start: approved.replaceStart, end: approved.replaceEnd, replacement: approved.replacement) {
                repairedLatePaste = repairLatePaste(element: element, duplicate: duplicate, expected: approved.resultingValue)
            }
            if usesPasteboard { pasteboard.restore() }
        }

        let verified = step == .verified
        var error: String?
        if case .failed(let code) = step { error = code }
        arbiter.finishInsertion(claimID: claim.claimID, error: error)

        var grant: UndoGrant?
        if verified, let origin {
            var target = live.identity
            target.elementRevision = UTF16Text.digest(approved.resultingValue)
            let writeID = writeIDs.withLock { id -> UInt64 in
                id &+= 1
                return id
            }
            // Bound before the grant exists anywhere else, so a ⌘Z that takes it always finds it.
            written.withLock { list in
                list.append((writeID, element, processStart))
                if list.count > 8 { list.removeFirst(list.count - 8) }
            }
            grant = UndoGrant(
                target: target, priorValue: live.value, writtenValue: approved.resultingValue,
                insertedStart: approved.replaceStart, insertedLength: UTF16Text.length(approved.replacement),
                origin: origin, writeID: writeID
            )
            if advanceAfterFill, stillTarget() {
                PidKeystrokeSynthesizer(pid: pid, element: element, stillTarget: stillTarget).tab()
            }
        }
        finish(ok: error == nil, error: error, verified: verified, method: method, fellBack: fellBack, undo: grant, repaired: repairedLatePaste)
    }

    /// After an AX fallback, watches briefly for a paste the app took before the clipboard was
    /// emptied and applied late, which would leave the text twice. Only that exact value is set
    /// back to the expected one. How long an app can hold a paste is not measured; this window is
    /// an assumption, and a paste applied after it is not caught.
    private func repairLatePaste(element: AXUIElement, duplicate: String, expected: String) -> Bool {
        let deadline = Date().addingTimeInterval(0.75)
        repeat {
            if FieldReader.read(element)?.value == duplicate {
                return AXRead.setString(kAXValueAttribute, expected, on: element) == .success
                    && FieldReader.read(element)?.value == expected
            }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < deadline
        return false
    }

    /// Replaces the approved span through `AXSelectedText` on the element itself.
    private func axWrite(_ edit: InsertionGuard.ApprovedEdit, element: AXUIElement, unchanged: String) -> Settle {
        guard AXRead.setRange(kAXSelectedTextRangeAttribute, location: edit.replaceStart, length: edit.replaceEnd - edit.replaceStart, on: element) == .success,
              AXRead.setString(kAXSelectedTextAttribute, edit.replacement, on: element) == .success
        else { return .different }
        return waitForSettle(element: element, expected: edit, unchanged: unchanged)
    }

    /// Polls the written element until it holds the predicted value, or it is clear that it will
    /// not: unchanged after `ignoredPasteAfter`, or anything else after `pasteSettleTimeout`.
    private func waitForSettle(element: AXUIElement, expected: InsertionGuard.ApprovedEdit, unchanged: String) -> Settle {
        let started = Date()
        var want = expected.target
        want.elementRevision = ""
        while true {
            let field = FieldReader.read(element)
            var identity = field?.identity
            identity?.elementRevision = ""
            if let settle = WriteFallback.classify(
                value: field?.value, sameElement: identity == want, expected: expected.resultingValue, unchanged: unchanged,
                elapsed: Date().timeIntervalSince(started), ignoredAfter: ignoredPasteAfter, timeout: pasteSettleTimeout
            ) { return settle }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    // MARK: - Undo

    private func runUndo(_ grant: UndoGrant) {
        func done(_ ok: Bool, _ error: String?) {
            status.update { $0.lastUndo = DebugState.UndoInfo(grantID: grant.id, ok: ok, error: error) }
            onUndone(UndoResult(grant: grant, ok: ok, error: error))
        }
        guard let (_, element, processStart) = written.withLock({ list in list.last { $0.0 == grant.writeID } }) else {
            return done(false, "elementUnknown")
        }
        guard policy.allowsLive(pid: grant.target.pid), ProcessStart.of(grant.target.pid) == processStart else {
            return done(false, "targetNotAllowed")
        }
        guard let live = FieldReader.read(element) else { return done(false, "fieldUnreadable") }
        let revert: UndoGuard.Revert
        switch UndoGuard.approve(grant, live: live.liveField) {
        case .failure(let rejection): return done(false, rejection.code)
        case .success(let r): revert = r
        }
        // AXValue rather than a posted ⌘Z: an AX-written fill left no step in the app's undo stack,
        // and the value to restore is known exactly.
        guard AXRead.setString(kAXValueAttribute, revert.expectedValue, on: element) == .success else {
            return done(false, "writeRefused")
        }
        let deadline = Date().addingTimeInterval(pasteSettleTimeout)
        repeat {
            if FieldReader.read(element)?.value == revert.expectedValue { return done(true, nil) }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < deadline
        done(false, "writeMismatch")
    }

    /// Runs async insertion to completion on this serial queue, so the next claim cannot start
    /// before the paste has finished.
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
