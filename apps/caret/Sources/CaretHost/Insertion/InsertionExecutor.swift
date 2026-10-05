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
/// 4. Write, rechecking before every AX call and every posted event that the claim's authorization
///    is still live (`HostAuthority`), the process is the same and the approved element still has
///    focus. By default an `AXSelectedText` replacement on the element itself. An app that refuses
///    it with an AX error gets a ⌘V posted to its pid through the reconciled pasteboard
///    (`ReconcilingPasteboard`) instead, and is remembered (`WriteMethodTable`). An app that takes
///    the AX write and shows nothing gets no second write now, since the first may still land; the
///    claim fails and the app pastes from its next one.
/// 5. Reread until the field holds exactly the value the guard predicted. After a paste, put the
///    user's clipboard back only if nobody wrote to it since Caret did, and if the field did not
///    take the paste, name the element that has focus now if the paste shows there
///    (`WriteFallback.strayInsertion`), without changing it.
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
        /// The field a paste landed in instead of the approved one, by its label.
        let strayField: String?
    }

    struct UndoResult: Sendable {
        let grant: UndoGrant
        let ok: Bool
        let error: String?
    }

    private typealias Settle = WriteFallback.Settle

    private let queue = DispatchQueue(label: "dev.caret.host.insertion", qos: .userInteractive)
    private static let log = Logger(subsystem: "dev.caret.host", category: "clipboard")
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let planner: InsertionPlanner
    private let policy: TargetPolicy
    let authority: HostAuthority
    let writeMethods = WriteMethodTable()
    /// Pastes through Caret's marked item and puts the user's clipboard back only if it is still
    /// Caret's (Sam's decision of 2026-10-04).
    private let pasteboard: ReconcilingPasteboard
    private let pasteSettleTimeout: TimeInterval = 1.5
    /// How long a write may leave the field untouched before the app is judged to ignore it.
    /// Assumed, not measured across apps: TextEdit applied A1's pastes within one 20 ms poll.
    private let ignoredAfter: TimeInterval = 0.5
    /// Move focus to the next field after a verified fill (SURFACES.md section 5).
    private let advanceAfterFill: Bool
    /// Test hooks only: how long Caret's item stays on the pasteboard after the field settles
    /// (`HostRuntime.Configuration.pasteRestoreDelay`).
    private let pasteRestoreDelay: TimeInterval
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
        authority: HostAuthority,
        advanceAfterFill: Bool,
        pasteRestoreDelay: TimeInterval = 0,
        pasteboard: ReconcilingPasteboard = ReconcilingPasteboard(),
        onFinished: @escaping @Sendable (Result) -> Void,
        onUndone: @escaping @Sendable (UndoResult) -> Void
    ) {
        self.arbiter = arbiter
        self.status = status
        self.planner = InsertionPlanner(compatibilityStore: compatibilityStore)
        self.policy = policy
        self.authority = authority
        self.advanceAfterFill = advanceAfterFill
        self.pasteRestoreDelay = pasteRestoreDelay
        self.pasteboard = pasteboard
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

    /// Tap thread or debug socket. Takes the claim's authorization at the key, then only enqueues.
    func submit(_ claim: Claim) {
        let grant = authority.grant()
        if claim.rangeEdit != nil {
            queue.async { [self] in runRange(claim, grant) }
        } else {
            queue.async { [self] in run(claim, grant) }
        }
    }

    /// Tap thread or debug socket. Only enqueues.
    func submitUndo(_ grant: UndoGrant) {
        let authorization = authority.grant()
        // On the tap thread the ⌘Z itself is already counted, so any later mark is the user's next input.
        let mark = status.inputMark()
        queue.async { [self] in runUndo(grant, authorization, since: mark) }
    }

    // MARK: - Insert

    private func run(_ claim: Claim, _ authorization: HostAuthority.Grant) {
        let started = DispatchTime.now().uptimeNanoseconds
        let text = claim.insertionText
        let pid = claim.offer.target.pid
        let origin = claim.offer.kind.fillOrigin
        let authority = self.authority
        let live = { authority.isLive(authorization) }

        func finish(
            ok: Bool, error: String?, verified: Bool?, method: FillResult.Method? = nil, fellBack: Bool = false,
            undo: UndoGrant? = nil, rejected: Bool = false, stray: String? = nil,
            clipboard: ReconcilingClipboard.Outcome? = nil, refused: [String] = [], types: [[String]]? = nil
        ) {
            var insertion = DebugState.Insertion(
                claimID: claim.claimID, ok: ok, error: error, text: text,
                durationMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
                verified: verified
            )
            insertion.kind = claim.offer.kind.name
            insertion.method = method?.rawValue
            insertion.fellBack = fellBack
            insertion.strayField = stray
            insertion.clipboard = clipboard?.name
            insertion.clipboardLost = clipboard?.lost.isEmpty == false ? clipboard?.lost : nil
            insertion.clipboardRefused = refused.isEmpty ? nil : refused
            insertion.clipboardTypes = types
            status.update { $0.lastInsertion = insertion }
            if let clipboard { status.increment("clipboard.\(clipboard.name)") }
            if !refused.isEmpty { status.increment("clipboard.refused") }
            if case .notRestored(let lost)? = clipboard {
                // Loud, because the user's clipboard is not what it was. Types and sizes only, never the
                // bytes: the clipboard is the user's.
                let line = "caret: CLIPBOARD NOT RESTORED after a paste into \(claim.offer.target.bundleID): \(lost.joined(separator: "; "))"
                Self.log.fault("\(line, privacy: .public)")
                FileHandle.standardError.write(Data((line + "\n").utf8))
            }
            onFinished(Result(claim: claim, insertion: insertion, undo: undo, reason: error, rejected: rejected, method: method, strayField: stray))
        }
        func refuse(_ reason: String) {
            arbiter.abandon(claimID: claim.claimID, reason: reason)
            finish(ok: false, error: reason, verified: nil, rejected: true)
        }

        guard live() else { return refuse("revoked") }
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
        let (element, before) = reread
        let approved: InsertionGuard.ApprovedEdit
        switch arbiter.confirm(claim, live: before.liveField) {
        case .failure(let rejection):
            return finish(ok: false, error: rejection.code, verified: nil, rejected: true)
        case .success(let edit):
            approved = edit
        }

        let appKey = WriteMethodTable.appKey(pid: pid)
        // Checked before every event and AX write: the claim still authorized, the same process
        // (not a new one reusing the pid), still allowed, and the approved element still focused,
        // since a pid-posted ⌘V goes to whichever field of the app has focus.
        let stillTarget = { [policy] in
            live() && ProcessStart.of(pid) == processStart && policy.allowsLive(pid: pid)
                && AXRead.focusedElement(pid: pid).map { CFEqual($0, element) } == true
        }
        let refusal = { live() ? "targetNotAllowed" : "revoked" }
        // A clipboard Caret cannot restore exactly refuses the paste route for this insert
        // (`WriteFallback.firstRoute`, `afterAXRefused`). The check's snapshot is the only one a paste
        // may write over and restore (`ReconcilingClipboard.arm`).
        var snapshot: ClipboardSnapshot?
        var clipboardRefused: [String] = []
        var clipboardTypes: [[String]]?
        let clipboardRestorable = { [pasteboard] () -> Bool in
            switch pasteboard.clipboard.check() {
            case .pasteable(let checked):
                (snapshot, clipboardRefused, clipboardTypes) = (checked, [], checked.types)
                return true
            case .refused(let reasons, let types):
                (snapshot, clipboardRefused, clipboardTypes) = (nil, reasons, types)
                return false
            }
        }
        // The clipboard is read only when a paste would come first; the AX route never touches it.
        let route: WriteFallback.Route = writeMethods.method(for: appKey) == .axSelectedText
            ? .axWrite : WriteFallback.firstRoute(appPastes: true, clipboardRestorable: clipboardRestorable())
        var method: FillResult.Method = route == .paste ? .pastePid : .axSelectedText
        var fellBack = false
        var stray: String?
        var clipboard: ReconcilingClipboard.Outcome?
        var step: WriteFallback.Step

        if method == .axSelectedText {
            step = axInsert(approved, element: element, unchanged: before.value, stillTarget: stillTarget, refusal: refusal)
            if step == .fallBackToPaste { step = WriteFallback.afterAXRefused(clipboardRestorable: clipboardRestorable()) }
            switch step {
            case .fallBackToPaste:
                // The app refused the AX write with an error, so nothing of it is pending: paste now,
                // and from now on.
                writeMethods.record(.pastePid, for: appKey)
                method = .pastePid
                fellBack = true
                let paste = pasteInsert(claim, snapshot: snapshot, approved: approved, element: element, before: before, stillTarget: stillTarget, refusal: refusal)
                (step, stray, clipboard) = (paste.step, paste.stray, paste.clipboard)
            case .failed(WriteFallback.clipboardUnrestorable):
                // Refused with an error and the clipboard could not survive a paste: nothing was
                // written. The app still needs a paste next time.
                writeMethods.record(.pastePid, for: appKey)
            case .failed("writeIgnored"):
                // The app took the AX write and showed nothing. It may still apply it, so a paste now
                // could double the text (A17 review): this claim fails, and the next one pastes.
                writeMethods.record(.pastePid, for: appKey)
            default:
                break
            }
        } else {
            let paste = pasteInsert(claim, snapshot: snapshot, approved: approved, element: element, before: before, stillTarget: stillTarget, refusal: refusal)
            (step, stray, clipboard) = (paste.step, paste.stray, paste.clipboard)
        }

        let verified = step == .verified
        var error: String?
        if case .failed(let code) = step { error = code }
        arbiter.finishInsertion(claimID: claim.claimID, error: error)

        var grant: UndoGrant?
        if verified, let origin {
            var target = before.identity
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
                target: target, priorValue: before.value, writtenValue: approved.resultingValue,
                insertedStart: approved.replaceStart, insertedLength: UTF16Text.length(approved.replacement),
                origin: origin, writeID: writeID
            )
            if advanceAfterFill, stillTarget() {
                PidKeystrokeSynthesizer(pid: pid, element: element, stillTarget: stillTarget).tab()
            }
        }
        finish(
            ok: error == nil, error: error, verified: verified, method: method, fellBack: fellBack, undo: grant,
            stray: stray, clipboard: clipboard, refused: clipboardRefused, types: clipboardTypes
        )
    }

    /// Replaces the approved span through `AXSelectedText` on the element itself: the selection,
    /// then the text, each only while the target still holds.
    private func axInsert(
        _ edit: InsertionGuard.ApprovedEdit, element: AXUIElement, unchanged: String,
        stillTarget: () -> Bool, refusal: () -> String
    ) -> WriteFallback.Step {
        guard stillTarget() else { return .failed(refusal()) }
        guard AXRead.setRange(kAXSelectedTextRangeAttribute, location: edit.replaceStart, length: edit.replaceEnd - edit.replaceStart, on: element) == .success else {
            return WriteFallback.afterAX(nil, refused: true)
        }
        guard stillTarget() else { return .failed(refusal()) }
        guard AXRead.setString(kAXSelectedTextAttribute, edit.replacement, on: element) == .success else {
            // Only the selection moved, to the approved span, which the paste then replaces.
            return WriteFallback.afterAX(nil, refused: true)
        }
        return WriteFallback.afterAX(waitForSettle(element: element, expected: edit, unchanged: unchanged), refused: false)
    }

    /// A ⌘V posted to the target's pid through KeyType's inserter and the reconciled pasteboard;
    /// an injection strategy types the text instead and never touches the pasteboard. If a posted
    /// paste did not reach the field, the after-read looks for it in the element that has focus now.
    private func pasteInsert(
        _ claim: Claim, snapshot: ClipboardSnapshot?, approved: InsertionGuard.ApprovedEdit, element: AXUIElement, before: FieldState,
        stillTarget: @escaping () -> Bool, refusal: () -> String
    ) -> (step: WriteFallback.Step, stray: String?, clipboard: ReconcilingClipboard.Outcome?) {
        let pid = claim.offer.target.pid
        // Only a checked snapshot may be pasted over, and only while the pasteboard is still at its
        // count. Once the clipboard refuses, nothing more is posted: no ⌘V (which would paste the
        // user's own contents) and no delete before or after it.
        let clipboardState = pasteboard.clipboard
        if let snapshot { clipboardState.arm(snapshot) } else { clipboardState.disarm("the paste route was taken without a checked clipboard") }
        let synthesizer = PidKeystrokeSynthesizer(pid: pid, element: element, stillTarget: { stillTarget() && clipboardState.refused.isEmpty })
        let inserter = PasteboardCompletionInserter(planner: planner, synthesizer: synthesizer, pasteboard: pasteboard, restoreDelayNanoseconds: 0)
        let context = contexts.withLock { list in list.last { $0.0 == claim.offer.id }?.1 }
            ?? TextFieldContext(beforeCursor: "", target: AppTarget(bundleIdentifier: claim.offer.target.bundleID, appName: ""))
        var plan = planner.plan(candidate: CompletionCandidate(text: claim.insertionText), context: context)
        let usesPasteboard: Bool
        switch plan.strategy {
        case .pasteboardPaste, .pasteAndMatchStyle, .firstWordOnly: usesPasteboard = true
        case .characterInjection, .chunkedStringInjection: usesPasteboard = false
        }
        // Restored here, after the field settles, not on KeyType's timer: an app that reads the
        // pasteboard late still pastes the suggestion and not the user's clipboard.
        plan.restorePasteboard = false
        let finalPlan = plan
        var postError = Self.blocking { try await inserter.insert(plan: finalPlan) }
        // Read before `restore`, which clears it.
        let refusedAtSave = !clipboardState.refused.isEmpty
        if refusedAtSave { FileHandle.standardError.write(Data("caret: paste not posted: \(clipboardState.refused.joined(separator: "; "))\n".utf8)) }
        if synthesizer.refusedPosts > 0 { postError = refusedAtSave ? WriteFallback.clipboardUnrestorable : refusal() }
        let settle: Settle = postError == nil ? waitForSettle(element: element, expected: approved, unchanged: before.value) : .different
        var clipboard: ReconcilingClipboard.Outcome?
        if usesPasteboard {
            if pasteRestoreDelay > 0 { Thread.sleep(forTimeInterval: pasteRestoreDelay) }
            pasteboard.restore()
            clipboard = pasteboard.lastOutcome
        }
        var step = WriteFallback.afterPaste(settle, postError: postError)
        var stray: String?
        // A ⌘V was posted and the approved element did not take it: it may have gone to the element
        // that took focus between the last check and the app handling the event. With no paste
        // posted (refused, never built, or a typed strategy) nothing is looked for.
        if step != .verified, synthesizer.pastesPosted > 0, FieldReader.read(element)?.value == before.value,
           let field = strayField(pid: pid, approved: element, inserted: approved.replacement) {
            step = .failed("wroteElsewhere")
            stray = field
        }
        return (step, stray, clipboard)
    }

    /// The label of the element of `pid` that has focus now, if it is not the approved one and the
    /// pasted text ends exactly at its caret. Nothing is changed there: the text before the caret
    /// could be the user's own, and nothing recorded says it is not (A17 review), so the failure names
    /// the field for the user to check.
    private func strayField(pid: pid_t, approved: AXUIElement, inserted: String) -> String? {
        guard let focused = AXRead.focusedElement(pid: pid), let field = FieldReader.read(focused),
              WriteFallback.strayInsertion(
                  focusIsApproved: CFEqual(focused, approved), value: field.value,
                  caret: field.selection.isEmpty ? field.selection.start : nil, inserted: inserted
              ) != nil
        else { return nil }
        status.increment("insertion.stray")
        return Self.label(of: focused)
    }

    /// A field's name as the user sees it: its title, description or placeholder, else its role.
    private static func label(of element: AXUIElement) -> String {
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute as String] {
            if let s = AXRead.string(attribute, on: element)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        if let title = AXRead.element(kAXTitleUIElementAttribute, on: element).flatMap({ AXRead.string(kAXValueAttribute, on: $0) }), !title.isEmpty {
            return title
        }
        return "another field"
    }

    /// Polls the written element until it holds the predicted value, or it is clear that it will
    /// not: unchanged after `ignoredAfter`, or anything else after `pasteSettleTimeout`.
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
                elapsed: Date().timeIntervalSince(started), ignoredAfter: ignoredAfter, timeout: pasteSettleTimeout
            ) { return settle }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    // MARK: - Undo

    /// Reverses exactly Caret's span as an edit (`AXSelectedText` over it set to ""), never by
    /// writing the whole value, which some apps take as a new document and lose their own undo
    /// history over (q1 bug 5).
    private func runUndo(_ grant: UndoGrant, _ authorization: HostAuthority.Grant, since mark: HostStatus.InputMark) {
        func done(_ ok: Bool, _ error: String?) {
            status.update {
                $0.lastUndo = DebugState.UndoInfo(grantID: grant.id, ok: ok, error: error, strategy: grant.rangeUndo == nil ? nil : grant.strategy.rawValue)
            }
            onUndone(UndoResult(grant: grant, ok: ok, error: error))
        }
        if grant.rangeUndo != nil { return runRangeUndo(grant, authorization, since: mark, done: done) }
        let authority = self.authority
        guard authority.isLive(authorization) else { return done(false, "revoked") }
        guard let (_, element, processStart) = written.withLock({ list in list.last { $0.0 == grant.writeID } }) else {
            return done(false, "elementUnknown")
        }
        let pid = grant.target.pid
        let stillTarget = { [policy] in
            authority.isLive(authorization) && policy.allowsLive(pid: pid) && ProcessStart.of(pid) == processStart
        }
        guard stillTarget() else { return done(false, "targetNotAllowed") }
        guard let live = FieldReader.read(element) else { return done(false, "fieldUnreadable") }
        let revert: UndoGuard.Revert
        switch UndoGuard.approve(grant, live: live.liveField) {
        case .failure(let rejection): return done(false, rejection.code)
        case .success(let r): revert = r
        }
        guard stillTarget() else { return done(false, authority.isLive(authorization) ? "targetNotAllowed" : "revoked") }
        guard AXRead.setRange(kAXSelectedTextRangeAttribute, location: revert.start, length: revert.length, on: element) == .success else {
            return done(false, "writeRefused")
        }
        guard stillTarget() else { return done(false, authority.isLive(authorization) ? "targetNotAllowed" : "revoked") }
        guard AXRead.setString(kAXSelectedTextAttribute, "", on: element) == .success else {
            return done(false, "writeRefused")
        }
        let deadline = Date().addingTimeInterval(pasteSettleTimeout)
        repeat {
            if FieldReader.read(element)?.value == revert.expectedValue { return done(true, nil) }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < deadline
        done(false, "writeMismatch")
    }

    // MARK: - Range edits (writing fixes)

    /// A writing fix: one range of the field replaced, bound by `RangeEdit` to the field as offered
    /// (`action-engine-v2.md` section 7). Only through Accessibility, never a paste: a range edit
    /// selects text the user did not select, and a pid-posted ⌘V lands in whichever field has
    /// focus when the app reads it (D2-09). An app that refuses the AX write gets nothing.
    ///
    /// 1. Reread the focused field of the offer's pid and `confirmRange` it (`.observed`).
    /// 2. Select the range: the one selection change acceptance authorizes. Reread and validate
    ///    again (`.rangeSelected`).
    /// 3. Write the replacement as the selected text, so the app records it as an edit of its own
    ///    and its undo keeps working.
    /// 4. Wait for the whole value to read back as predicted, put the user's caret back where it was
    ///    (carried through the edit), reread, and `verify`: that gives the undo.
    /// Every step asks first that the authorization is live, the process the same, and the field
    /// still the focused element.
    private func runRange(_ claim: Claim, _ authorization: HostAuthority.Grant) {
        let started = DispatchTime.now().uptimeNanoseconds
        guard let edit = claim.rangeEdit else { return }
        let pid = claim.offer.target.pid
        let authority = self.authority
        let live = { authority.isLive(authorization) }

        func finish(error: String?, rejected: Bool = false, undo: UndoGrant? = nil) {
            var insertion = DebugState.Insertion(
                claimID: claim.claimID, ok: error == nil, error: error, text: edit.replacement,
                durationMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
                verified: rejected ? nil : error == nil
            )
            insertion.kind = claim.offer.kind.name
            insertion.method = rejected ? nil : FillResult.Method.axSelectedText.rawValue
            status.update { $0.lastInsertion = insertion }
            status.increment(error == nil ? "writing.fixed" : "writing.\(error ?? "failed")")
            onFinished(Result(
                claim: claim, insertion: insertion, undo: undo, reason: error, rejected: rejected,
                method: rejected ? nil : .axSelectedText, strayField: nil
            ))
        }
        func refuse(_ reason: String) {
            arbiter.abandon(claimID: claim.claimID, reason: reason)
            finish(error: reason, rejected: true)
        }

        guard live() else { return refuse("revoked") }
        guard policy.allowsLive(pid: pid), let processStart = ProcessStart.of(pid) else { return refuse("targetNotAllowed") }
        guard let (element, before) = FieldReader.readFocused(pid: pid) else { return refuse("fieldUnreadable") }
        if case .failure(let refusal) = arbiter.confirmRange(claim, live: Self.rangeLive(before)) {
            return finish(error: refusal.code, rejected: true)
        }
        let stillTarget = { [policy] in
            live() && ProcessStart.of(pid) == processStart && policy.allowsLive(pid: pid)
                && AXRead.focusedElement(pid: pid).map { CFEqual($0, element) } == true
        }
        let outcome = applyRange(edit, element: element, before: before, stillTarget: stillTarget, refusal: { live() ? "targetNotAllowed" : "revoked" })
        switch outcome {
        case .failed(let code):
            arbiter.finishInsertion(claimID: claim.claimID, error: code)
            finish(error: code)
        case .applied(let applied):
            arbiter.finishInsertion(claimID: claim.claimID, error: nil)
            let writeID = writeIDs.withLock { id -> UInt64 in
                id &+= 1
                return id
            }
            written.withLock { list in
                list.append((writeID, element, processStart))
                if list.count > 8 { list.removeFirst(list.count - 8) }
            }
            finish(error: nil, undo: .range(applied.undo, priorValue: before.value, writtenValue: applied.value, writeID: writeID,
                                            strategy: NativeUndoApps.strategy(bundleID: claim.offer.target.bundleID)))
        }
    }

    /// ⌘Z on a writing fix's toast: the undo `verify` built, through the same range steps, on the
    /// grant ⌘Z took. The field must still hold exactly what the fix left and the caret must be
    /// where the fix put it back; otherwise nothing is written and the toast says why.
    private func runRangeUndo(_ grant: UndoGrant, _ authorization: HostAuthority.Grant, since mark: HostStatus.InputMark, done: (Bool, String?) -> Void) {
        guard let undo = grant.rangeUndo else { return done(false, "noUndo") }
        let authority = self.authority
        guard authority.isLive(authorization) else { return done(false, "revoked") }
        guard let (_, element, processStart) = written.withLock({ list in list.last { $0.0 == grant.writeID } }) else {
            return done(false, "elementUnknown")
        }
        let pid = grant.target.pid
        let stillTarget = { [policy] in
            authority.isLive(authorization) && policy.allowsLive(pid: pid) && ProcessStart.of(pid) == processStart
                && AXRead.focusedElement(pid: pid).map { CFEqual($0, element) } == true
        }
        if grant.strategy == .nativeUndo {
            let status = self.status
            let target = NativeUndoOnApp(pid: pid, element: element, stillTarget: stillTarget, live: { authority.isLive(authorization) },
                                         quiet: { status.inputMark() == mark })
            let outcome = NativeUndo.run(grant, on: target)
            return done(outcome == .reverted, outcome.error)
        }
        guard stillTarget() else { return done(false, authority.isLive(authorization) ? "targetNotAllowed" : "revoked") }
        guard let before = FieldReader.read(element) else { return done(false, "fieldUnreadable") }
        if case .failure(let refusal) = undo.validate(Self.rangeLive(before), phase: .observed) { return done(false, refusal.code) }
        switch applyRange(undo, element: element, before: before, stillTarget: stillTarget, refusal: { authority.isLive(authorization) ? "targetNotAllowed" : "revoked" }) {
        case .failed(let code): done(false, code)
        case .applied: done(true, nil)
        }
    }

    private struct AppliedRange {
        /// The whole value after the write.
        let value: String
        let undo: RangeEdit
    }

    private enum RangeOutcome {
        case applied(AppliedRange)
        case failed(String)
    }

    /// Steps 2 to 4 of `runRange`, for a fix and for its undo. `before` was validated `.observed`.
    private func applyRange(
        _ edit: RangeEdit, element: AXUIElement, before: FieldState, stillTarget: () -> Bool, refusal: () -> String
    ) -> RangeOutcome {
        // Puts the user's selection back after a refusal, only while the field is exactly as it was
        // read and the selection is still the range Caret selected: nothing of the fix was written,
        // and a selection the user made since (a click) is theirs to keep.
        func restoreSelection() {
            guard stillTarget(), let live = FieldReader.read(element), live.value.utf16.elementsEqual(before.value.utf16),
                  live.selection == UTF16Selection(start: edit.replace.start, end: edit.replace.end)
            else { return }
            AXRead.setRange(kAXSelectedTextRangeAttribute, location: edit.observedSelection.start, length: edit.observedSelection.end - edit.observedSelection.start, on: element)
        }
        guard stillTarget() else { return .failed(refusal()) }
        guard AXRead.setRange(kAXSelectedTextRangeAttribute, location: edit.replace.start, length: edit.replace.length, on: element) == .success else {
            return .failed("writeRefused")
        }
        guard let selected = FieldReader.read(element) else {
            restoreSelection()
            return .failed("fieldUnreadable")
        }
        let approved: RangeEdit.Approved
        switch edit.validate(Self.rangeLive(selected), phase: .rangeSelected) {
        case .failure(let refusal):
            restoreSelection()
            return .failed(refusal.code)
        case .success(let a):
            approved = a
        }
        guard stillTarget() else {
            restoreSelection()
            return .failed(refusal())
        }
        guard AXRead.setString(kAXSelectedTextAttribute, edit.replacement, on: element) == .success else {
            restoreSelection()
            return .failed("writeRefused")
        }
        // Until the whole value is the predicted one, unit for unit; unchanged after `ignoredAfter`
        // means the app ignored the write, anything else after the timeout a mismatch.
        let settleStart = Date()
        while true {
            let value = FieldReader.read(element)?.value
            if value?.utf16.elementsEqual(approved.resultingValue.utf16) == true { break }
            let elapsed = Date().timeIntervalSince(settleStart)
            if value?.utf16.elementsEqual(before.value.utf16) == true, elapsed > ignoredAfter {
                restoreSelection()
                return .failed("writeIgnored")
            }
            if elapsed > pasteSettleTimeout { return .failed("writeMismatch") }
            Thread.sleep(forTimeInterval: 0.02)
        }
        // The app leaves the caret after the new text; the user's goes back where it was.
        let caret = approved.resultingSelection
        if stillTarget() {
            AXRead.setRange(kAXSelectedTextRangeAttribute, location: caret.start, length: caret.end - caret.start, on: element)
        }
        guard let after = FieldReader.read(element) else { return .failed("fieldUnreadable") }
        switch edit.verify(after: Self.rangeLive(after), approved: approved) {
        case .failure(let refusal): return .failed(refusal.code)
        case .success(let undo): return .applied(AppliedRange(value: approved.resultingValue, undo: undo))
        }
    }

    /// `NativeUndo`'s effects on the app: Accessibility reads, one pid-directed ⌘Z, a caret move.
    private struct NativeUndoOnApp: NativeUndoTarget {
        let pid: pid_t
        let element: AXUIElement
        let stillTarget: () -> Bool
        let live: () -> Bool
        /// No key or click from the user since the toast's ⌘Z: a key typed before the posted ⌘Z
        /// lands would be what it undoes, and a click after it is a selection not to overwrite.
        let quiet: () -> Bool

        func refusal() -> String? {
            guard stillTarget() else { return live() ? "targetNotAllowed" : "revoked" }
            return quiet() ? nil : "inputDuringUndo"
        }

        /// Accessibility's system-wide focused application, read live. Not
        /// `NSRunningApplication.isActive`: its time-varying properties change only as the main run
        /// loop runs (NSRunningApplication.h), and this runs on the insertion queue.
        func isFrontmost() -> Bool {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value) == .success,
                  let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
            var focused: pid_t = 0
            return AXUIElementGetPid(value as! AXUIElement, &focused) == .success && focused == pid
        }

        func read() -> RangeEdit.Live? { FieldReader.read(element).map(InsertionExecutor.rangeLive) }

        /// The synthesizer asks again immediately before the key-down: target, quiet and frontmost.
        func postUndo() -> Bool {
            PidKeystrokeSynthesizer(pid: pid, element: element, stillTarget: { refusal() == nil && isFrontmost() }).undo()
        }
        func select(_ selection: UTF16Selection) {
            AXRead.setRange(kAXSelectedTextRangeAttribute, location: selection.start, length: selection.end - selection.start, on: element)
        }
        func sleep(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
        var now: Date { Date() }
    }

    /// The field as the range guard reads it. Input-method composition is not visible through
    /// Accessibility; `InputMethodState` says whether the current input source composes at all.
    static func rangeLive(_ field: FieldState) -> RangeEdit.Live {
        RangeEdit.Live(target: field.identity, value: field.value, selection: field.selection, secure: field.secure, composing: InputMethodState.shared.composes)
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
