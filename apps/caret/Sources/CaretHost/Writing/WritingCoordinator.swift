import AppKit
import ApplicationServices
import CaretHostCore
import Foundation

/// Spelling, grammar and punctuation in the focused prose field (`action-engine-v2.md` section 7,
/// lead decision 4): a quiet underline under each error, and a line under the one nearest the caret
/// whose Tab fixes exactly that range.
///
/// - Producers: when a read of the field shows a sentence just finished (`WritingMarks.boundary`),
///   the static rules (`WritingCheck`) and the system checker (`NativeChecker`) check that sentence.
///   Their marks then follow the text until the next check (`WritingMarks.observe`).
/// - The line is an offer in the arbiter's one slot (`OfferKind.writing`), published only when it
///   can be drawn: under the error's own text bounds (`AXBoundsForRange`), or under the caret when
///   the field gives none, with no underline then. Typing, a selection change or another field takes
///   it down; the marks stay.
/// - Tab's claim goes to `InsertionExecutor.runRange` (AX only). Its result toast holds the
///   arbiter's toast slot with the range undo; ⌘Z runs that on its own grant.
/// - Esc leaves the mark quiet and never offers it again; Original removes it, and for a spelling
///   mark tells the field's spell document to ignore the word.
@MainActor
final class WritingCoordinator {
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let policy: TargetPolicy
    private let overlay = WritingOverlay()
    private let checker = NativeChecker()
    /// Not paused, and words on (`HostGate.allowsGhostText`): writing help rides the same role.
    var allowed: () -> Bool = { true }
    /// The router's answer for ambient help (H6): the line is offered only where it allows. The
    /// marks themselves stay, quiet, whatever it says (lead decision 4). Nil offers as before.
    var route: RouteLink?
    /// A check found marks while the router's decision was awaited: offer them when it comes.
    private var offerWhenRouted = false
    /// This coordinator's toast took the arbiter's toast slot; the other owners take theirs down.
    var onToastShown: (() -> Void)?

    private var marks = WritingMarks()
    private var element: AXUIElement?
    private var field: FieldState?
    private var previousValue: String?
    private var caretRect: CGRect?
    /// The value Caret's last fix or undo is expected to leave, so the read it causes does not count
    /// as the user finishing a sentence.
    private var ownWrite: String?
    /// The sentences Caret's last fix wrote into, in the value it leaves: their marks were dropped
    /// (the text around them changed), so they are checked again, quietly, once the write lands.
    private var recheckAfterWrite: UTF16Span?
    private var checkTask: Task<Void, Never>?
    private var checks = 0
    private var lastCheck: String?

    private struct Shown {
        var offerID: UInt64
        /// The mark the line is for: what Esc declines and Original removes.
        var active: WritingCorrection
        var value: String
        var selection: UTF16Selection
        var placement: WritingOverlay.Placement
    }
    private var shown: Shown?
    /// The alternative the last claim took, for the toast's words and the undo's.
    private var taken: (claimID: UInt64, alternative: WritingOffer.Alternative)?
    private var toastGrantID: UInt64?
    private var undone: WritingOffer.Alternative?
    private var resultTimer: Timer?
    private var expiryTimer: Timer?
    /// Rechecks geometry while something is drawn: a scroll moves text with no notification.
    private var geometryTimer: Timer?

    /// The language checks run in, from the user's macOS languages; nil: static rules only.
    private let language = NativeChecker.checkingLanguage(
        preferred: Locale.preferredLanguages, available: NSSpellChecker.shared.availableLanguages
    )

    /// Apps whose text areas hold code or a shell, not prose. Assumed, not measured: a short list
    /// of the common ones; a sentence that looks like code is skipped anywhere (`looksLikeCode`).
    static let nonProseBundles: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
        "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "dev.zed.Zed",
    ]
    static let resultSeconds: TimeInterval = UndoGrant.defaultLifetime
    static let errorSeconds: TimeInterval = 3

    init(arbiter: OfferArbiter, status: HostStatus, policy: TargetPolicy) {
        self.arbiter = arbiter
        self.status = status
        self.policy = policy
    }

    // MARK: - Reads of the focused field

    func handle(_ change: FocusObserver.Change) {
        guard allowed(), let element = change.element else { return leaveField() }
        // A read of the same element that fails, or comes back without its role, is a slow app,
        // not the user leaving: keep the marks, the line and the result until a read says more.
        let sameElement = self.element.map { CFEqual($0, element) } ?? false
        guard let field = FieldReader.read(element) else {
            if sameElement { return status.increment("writing.readFailed") }
            return leaveField()
        }
        if sameElement, field.role == nil { return status.increment("writing.readFailed") }
        guard policy.allows(pid: field.identity.pid, bundleID: field.identity.bundleID),
              !AppSwitch.shared.isOff(bundleID: field.identity.bundleID),
              !SecretField.holdsSecret(field, traits: change.snapshot?.context.traits), Self.isProse(element, field: field)
        else { return leaveField() }
        if marks.observe(field: field.identity, value: field.value) {
            previousValue = nil
            takeLineDown(exit: 0)
            checkTask?.cancel()
            sentenceCheck = nil
            // A result reports on the field it came from; its ⌘Z goes with it.
            endResult(exit: 0)
            ownWrite = nil
            recheckAfterWrite = nil
        }
        let previous = previousValue
        previousValue = field.value
        self.element = element
        self.field = field
        caretRect = change.snapshot?.caretRectAX

        // The line belongs to the field state it was offered on. Keys that change it already took
        // it down in the arbiter; a click that moved the caret did not.
        if let shown, !(shown.value.utf16.elementsEqual(field.value.utf16) && shown.selection == field.selection) {
            arbiter.invalidate(offerID: shown.offerID)
            takeLineDown(exit: 0.08)
        }
        if let ownWrite, ownWrite.utf16.elementsEqual(field.value.utf16) {
            self.ownWrite = nil
            if let span = recheckAfterWrite {
                recheckAfterWrite = nil
                check(span, in: field, offering: false)
            }
        } else if let sentence = WritingMarks.boundary(previous: previous, value: field.value, selection: field.selection) {
            check(sentence, in: field)
        } else if let word = WordFix.closedWord(previous: previous, value: field.value, selection: field.selection),
                  WordFix.eligible(word, in: field.value) {
            checkWord(word, in: field)
        }
        drawMarks()
    }

    /// The router's answer changed: marks a check found while it waited get their line now, if the
    /// field still reads as it was checked (`offerNearestMark` reads it again).
    func routeChanged() {
        // A decision that ends ambient help takes down a line already up; the marks stay, quiet.
        if shown != nil, !(route?.gate().allows ?? true) {
            takeLineDown(exit: 0.08)
            status.increment("routing.writingWithdrawn")
            offerWhenRouted = true
            return
        }
        guard offerWhenRouted, shown == nil else { return }
        offerNearestMark()
    }

    private func leaveField() {
        offerWhenRouted = false
        checkTask?.cancel()
        sentenceCheck = nil
        takeLineDown(exit: 0)
        endResult(exit: 0)
        ownWrite = nil
        recheckAfterWrite = nil
        marks.clear()
        element = nil
        field = nil
        previousValue = nil
        overlay.hideUnderlines()
        stopGeometryWatch()
        publishStatus()
    }

    static func isProse(_ element: AXUIElement, field: FieldState) -> Bool {
        guard field.role == "AXTextArea" || field.role == "AXTextField", !nonProseBundles.contains(field.identity.bundleID) else { return false }
        return AXRead.string(kAXSubroleAttribute, on: element) != "AXSearchField"
    }

    // MARK: - Checking

    /// `offering: false` records the marks without a line: a result is showing in the panel.
    private func check(_ sentence: UTF16Span, in field: FieldState, offering: Bool = true) {
        guard let text = UTF16Text.slice(field.value, start: sentence.start, end: sentence.end) else { return }
        if WritingText.looksLikeCode(text) { return noteCheck("skippedCode") }
        if InputMethodState.shared.composes { return noteCheck("skippedComposing") }
        checks += 1
        let value = field.value
        let rules = WritingCheck.check(value, sentence: sentence, language: language ?? "en")
        checkTask?.cancel()
        guard let language, NativeChecker.supports(language) else {
            noteCheck("noLanguage")
            return finishCheck(rules, sentence: sentence, value: value, offering: offering)
        }
        let key = NativeChecker.FieldKey(field.identity)
        let token = checks
        sentenceCheck = token
        checkTask = Task { [weak self, checker] in
            let outcome = await checker.check(value, sentence: sentence, language: language, field: key)
            if self?.sentenceCheck == token { self?.sentenceCheck = nil }
            guard let self, !Task.isCancelled else { return }
            guard case .corrections(let found) = outcome else { return self.noteCheck("stale") }
            self.noteCheck("checked")
            self.finishCheck(WritingCheck.merged(rules, found), sentence: sentence, value: value, offering: offering)
        }
    }

    /// The sentence check waiting for the system checker, by its number in `checks`. A word check
    /// started now would make its answer stale (`NativeChecker` keeps only a field's newest check), so
    /// none starts. Cleared when that check answers or is cancelled.
    private var sentenceCheck: Int?

    /// Brief item 5: the word just closed, checked for spelling alone. Only a fix `WordFix.offersLive`
    /// accepts becomes a mark, bound to the word's own span so typing on after it keeps it
    /// (`WritingMarks.rebase`); the sentence check later replaces it with what it finds there.
    private func checkWord(_ word: UTF16Span, in field: FieldState) {
        guard sentenceCheck == nil else { return noteCheck("wordSkippedForSentence") }
        if InputMethodState.shared.composes { return noteCheck("skippedComposing") }
        guard let language, NativeChecker.supports(language) else { return }
        let value = field.value
        let key = NativeChecker.FieldKey(field.identity)
        checkTask?.cancel()
        checkTask = Task { [weak self, checker] in
            let outcome = await checker.check(value, sentence: word, language: language, field: key)
            guard let self, !Task.isCancelled else { return }
            guard case .corrections(let found) = outcome else { return self.noteCheck("wordStale") }
            let live = found.filter { word.contains($0.span) && WordFix.offersLive($0) }
            self.noteCheck(live.isEmpty ? "wordClean" : "wordFix")
            guard !live.isEmpty else { return }
            self.finishCheck(live, sentence: word, value: value, offering: true)
        }
    }

    private func noteCheck(_ outcome: String) {
        lastCheck = outcome
        status.increment("writing.check.\(outcome)")
        publishStatus()
    }

    private func finishCheck(_ found: [WritingCorrection], sentence: UTF16Span, value: String, offering: Bool) {
        guard marks.record(found, sentence: sentence, checkedValue: value) else { return noteCheck("stale") }
        if offering { offerNearestMark() }
        drawMarks()
    }

    // MARK: - The line

    /// Publishes the line for the mark nearest the caret, against a fresh read of the field.
    private func offerNearestMark() {
        offerWhenRouted = false
        switch route?.gate() ?? .allow(.off) {
        case .allow: break
        case .wait:
            offerWhenRouted = true
            return status.increment("routing.writingHeld")
        case .quiet(let why):
            return status.increment("routing.writingQuiet.\(why.rawValue)")
        }
        guard let element, let field = FieldReader.read(element), field.identity == self.field?.identity,
              field.value.utf16.elementsEqual(marks.value.utf16)
        else { return }
        let candidates = marks.offerable(caret: field.selection.end)
        guard !candidates.isEmpty else { return }
        let live = RangeEdit.Live(target: field.identity, value: field.value, selection: field.selection, secure: field.secure, composing: InputMethodState.shared.composes)
        guard let writing = WritingOffer.correction(
            marks: candidates, checkedRevision: UTF16Text.digest(field.value), live: live, language: language ?? "en"
        ) else { return status.increment("writing.noOffer") }
        guard let placement = placement(for: writing, element: element, field: field) else {
            return status.increment("writing.noPlacement")
        }
        let anchor = CGPoint(x: placement.under.midX, y: placement.under.midY)
        if let hold = Visibility.hold(for: field.identity, anchors: [anchor]) {
            return status.increment("held.writing.\(hold.rawValue)")
        }
        let offer = Offer(
            text: "", kind: .writing(writing), target: field.identity, fieldValue: field.value,
            caretUTF16: field.selection.end, maxAgeSeconds: RangeEdit.defaultMaxAge
        )
        guard let id = arbiter.publish(offer) else { return status.increment("writing.refused") }
        shown = Shown(offerID: id, active: writing.active, value: field.value, selection: field.selection, placement: placement)
        overlay.showOffer(writing, at: placement, entering: true)
        startExpiry(id)
        startGeometryWatch()
        announce(writing.spokenLine)
        status.increment("writing.offered")
    }

    /// Under the active mark's text when the field gives its bounds on one line, the line's
    /// preview words over the error's (the inset of `CorrectionLineView` to its text); else under
    /// the caret. Nil when neither is known.
    private func placement(for writing: WritingOffer, element: AXUIElement, field: FieldState) -> WritingOverlay.Placement? {
        if let rect = textRect(writing.active.span, element: element) {
            let contextStart = writing.active.span.start - UTF16Text.length(writing.linePreview.before)
            let contextX = contextStart < writing.active.span.start
                ? AXRead.bounds(location: contextStart, length: 1, on: element)?.minX ?? rect.minX : rect.minX
            let inset: CGFloat = writing.presentation == .expanded ? 34 : 30
            return WritingOverlay.Placement(under: rect, x: contextX - inset, anchoredBy: "bounds")
        }
        guard let caret = caretRect else { return nil }
        return WritingOverlay.Placement(under: caret, x: caret.minX - 30, anchoredBy: "caret")
    }

    /// The text rect of `span`, or nil: no bounds, a rect on more than one line (wrapped), or one
    /// outside the part of the field on screen (`visible`, from `visibleFrame`).
    private func textRect(_ span: UTF16Span, element: AXUIElement, visible: CGRect? = nil) -> CGRect? {
        guard let visible = visible ?? visibleFrame(of: element), !span.isEmpty,
              let rect = AXRead.bounds(location: span.start, length: span.length, on: element),
              let first = AXRead.bounds(location: span.start, length: 1, on: element),
              rect.height < first.height * 1.5,
              visible.contains(CGPoint(x: rect.midX, y: rect.midY))
        else { return nil }
        return rect
    }

    /// The part of the field on screen: its frame clipped to its scroll areas, window and screen.
    private func visibleFrame(of element: AXUIElement) -> CGRect? {
        guard let frame = AXRead.frame(of: element) else { return nil }
        return AXRead.visibleFrame(of: element, frame: frame, screen: Screen.axVisibleFrame(around: frame))
    }

    /// Takes the line down and its offer out of the arbiter: an offer nobody can see must not hold
    /// Tab. `invalidate(offerID:)` leaves a newer offer alone.
    private func takeLineDown(exit: TimeInterval) {
        expiryTimer?.invalidate()
        expiryTimer = nil
        guard let shown else { return }
        arbiter.invalidate(offerID: shown.offerID)
        self.shown = nil
        if overlay.role == .line || overlay.role == .expanded { overlay.hidePanel(exit: exit) }
    }

    private func startExpiry(_ offerID: UInt64) {
        expiryTimer?.invalidate()
        expiryTimer = Timer.scheduledTimer(withTimeInterval: RangeEdit.defaultMaxAge, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.shown?.offerID == offerID else { return }
                self.arbiter.invalidate(offerID: offerID)
                self.takeLineDown(exit: 0.1)
                self.drawMarks()
            }
        }
    }

    private func announce(_ text: String) {
        guard NSWorkspace.shared.isVoiceOverEnabled else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue,
        ])
    }

    // MARK: - Underlines

    private func drawMarks() {
        guard let element, !marks.marks.isEmpty else {
            overlay.hideUnderlines()
            if shown == nil, overlay.role == nil { stopGeometryWatch() }
            return publishStatus()
        }
        let active = shown.flatMap { s in arbiter.snapshot().current.flatMap { $0.id == s.offerID ? $0.kind.writing?.active : nil } }
        var underlines: [WritingOverlay.Underline] = []
        var withBounds = Set<Int>()
        let visible = visibleFrame(of: element)
        for (i, mark) in marks.marks.enumerated().prefix(8) {
            guard let visible, let rect = textRect(mark.correction.span, element: element, visible: visible) else { continue }
            withBounds.insert(i)
            underlines.append(WritingOverlay.Underline(rect: rect, active: mark.correction == active))
        }
        // Never over another window: a field that is covered, or not where the user is looking,
        // shows no marks until it is again.
        if let field, let first = underlines.first,
           Visibility.hold(for: field.identity, anchors: [CGPoint(x: first.rect.midX, y: first.rect.midY)]) != nil {
            underlines = []
        }
        overlay.showUnderlines(underlines)
        startGeometryWatch()
        publishStatus(withBounds: withBounds)
    }

    private func startGeometryWatch() {
        guard geometryTimer == nil else { return }
        geometryTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.recheckGeometry() }
        }
    }

    private func stopGeometryWatch() {
        geometryTimer?.invalidate()
        geometryTimer = nil
    }

    /// A scroll or a moved window shifts the text under what is drawn. The underlines follow; a
    /// line whose error moved goes (`action-engine-v2.md` section 7: a scroll that invalidates
    /// geometry dismisses), and so does one whose field is no longer where the user is looking.
    private func recheckGeometry() {
        guard element != nil, !marks.marks.isEmpty || shown != nil else { return stopGeometryWatch() }
        if let shown, let element, let field {
            let current = arbiter.snapshot().current
            let writing = current?.id == shown.offerID ? current?.kind.writing : nil
            let moved = writing.map { placement(for: $0, element: element, field: field)?.under != shown.placement.under } ?? true
            let hidden = Visibility.hold(for: field.identity, anchors: [CGPoint(x: shown.placement.under.midX, y: shown.placement.under.midY)]) != nil
            if moved || hidden {
                arbiter.invalidate(offerID: shown.offerID)
                takeLineDown(exit: 0.1)
                status.increment(hidden ? "withdrawn.writing.hidden" : "withdrawn.writing.moved")
            }
        }
        drawMarks()
    }

    // MARK: - Keys (posted to main by the tap thread)

    func navigated(offerID: UInt64, ui: OfferUI) {
        guard let shown, shown.offerID == offerID, let writing = arbiter.snapshot().current?.kind.writing,
              let element, let field else { return }
        // The open list sits under the error's own words; the line under the context word.
        let placement = placement(for: writing, element: element, field: field) ?? shown.placement
        self.shown?.placement = placement
        overlay.showOffer(writing, at: placement, entering: false)
        publishStatus()
    }

    func offerChanged(_ reason: OfferArbiter.PassReason) {
        switch reason {
        case .dismissed, .expired, .closed:
            guard let shown, arbiter.snapshot().current?.id != shown.offerID else { return }
            takeLineDown(exit: reason == .dismissed ? 0.08 : 0.1)
            drawMarks()
        case .toastDismissed:
            guard let id = toastGrantID, arbiter.snapshot().toast?.id != id else { return }
            endResult(exit: 0.08)
        default:
            break
        }
    }

    /// Esc or Original closed the line. Called before `offerChanged(.closed)`.
    func offerClosed(_ offerID: UInt64) {
        guard let shown, shown.offerID == offerID else { return }
        let active = shown.active
        if arbiter.snapshot().keptOriginalOfferID == offerID {
            marks.remove(active)
            if active.kind == .spelling, let field {
                NSSpellChecker.shared.ignoreWord(active.original, inSpellDocumentWithTag: checker.tag(for: NativeChecker.FieldKey(field.identity)))
            }
            status.increment("writing.keptOriginal")
        } else {
            marks.decline(active)
            status.increment("writing.declined")
        }
        takeLineDown(exit: 0.1)
        drawMarks()
    }

    func displaced(_ offer: Offer) {
        guard let shown, shown.offerID == offer.id else { return }
        takeLineDown(exit: 0.08)
        drawMarks()
    }

    func claimed(_ claim: Claim) {
        guard claim.offer.kind.writing != nil, let shown, shown.offerID == claim.offer.id else { return }
        if let edit = claim.rangeEdit, let writing = claim.offer.kind.writing, writing.alternatives.indices.contains(claim.choice.candidate),
           let prefix = UTF16Text.slice(claim.offer.fieldValue, start: 0, end: edit.replace.start),
           let suffix = UTF16Text.slice(claim.offer.fieldValue, start: edit.replace.end, end: UTF16Text.length(claim.offer.fieldValue)) {
            taken = (claim.claimID, writing.alternatives[claim.choice.candidate])
            ownWrite = prefix + edit.replacement + suffix
            // Every sentence a mark under the edit was checked in, as it will read after the write.
            let touched = marks.marks.filter { $0.correction.span.overlaps(edit.replace) || edit.replace.contains($0.correction.span) }.map(\.sentence)
            let start = (touched.map(\.start) + [edit.replace.start]).min() ?? edit.replace.start
            let end = (touched.map(\.end) + [edit.replace.end]).max() ?? edit.replace.end
            recheckAfterWrite = UTF16Span(start: start, end: end + UTF16Text.length(edit.replacement) - edit.replace.length)
        }
        // Tab acted: the line goes at once; the result replaces it.
        expiryTimer?.invalidate()
        self.shown = nil
        overlay.hidePanel(exit: 0)
    }

    // MARK: - Results

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard result.claim.offer.kind.writing != nil else { return }
        let alternative = taken?.claimID == result.claim.claimID ? taken?.alternative : nil
        taken = nil
        // Focus moved on while the write ran: the result has no field to report on here, and its
        // ⌘Z must not wait for a key meant for another field. Asked of the app now, not of the
        // last read, which can lag a click by one coalesced notification.
        let target = result.claim.offer.target
        let focusedNow = FieldReader.readFocused(pid: target.pid)?.field.identity
        guard field != nil, focusedNow?.elementID == target.elementID, focusedNow?.windowID == target.windowID else {
            ownWrite = nil
            recheckAfterWrite = nil
            return status.increment("writing.resultForAnotherField")
        }
        // Under the words the fix put in, when the field gives their bounds.
        var placement = resultPlacement()
        if result.insertion.ok, let edit = result.claim.rangeEdit, let element,
           let rect = textRect(UTF16Span(start: edit.replace.start, end: edit.replace.start + UTF16Text.length(edit.replacement)), element: element) {
            placement = WritingOverlay.Placement(under: rect, x: rect.minX - 30, anchoredBy: "bounds")
        }
        if result.insertion.ok, let grant = result.undo, let alternative, let content = WritingOffer.toast(after: alternative) {
            toastGrantID = arbiter.showToast(grant)
            undone = alternative
            onToastShown?()
            if let placement { overlay.showResult(content, at: placement, role: .toast) }
            scheduleResultEnd(after: Self.resultSeconds)
        } else {
            ownWrite = nil
            recheckAfterWrite = nil
            if let placement { overlay.showResult(WritingCopy.error(WritingCopy.notFixed(result.reason ?? "")), at: placement, role: .error) }
            scheduleResultEnd(after: Self.errorSeconds)
        }
        drawMarks()
    }

    func undoStarted(_ grant: UndoGrant) {
        guard grant.rangeUndo != nil, grant.id == toastGrantID else { return }
        toastGrantID = nil
        if let undo = grant.rangeUndo, let prefix = UTF16Text.slice(grant.writtenValue, start: 0, end: undo.replace.start),
           let suffix = UTF16Text.slice(grant.writtenValue, start: undo.replace.end, end: UTF16Text.length(grant.writtenValue)) {
            ownWrite = prefix + undo.replacement + suffix
        }
    }

    func undoFinished(_ result: InsertionExecutor.UndoResult) {
        guard result.grant.rangeUndo != nil else { return }
        let content = result.ok ? undone.map(WritingCopy.undone) : WritingCopy.error(WritingCopy.undoFailed)
        undone = nil
        if !result.ok { ownWrite = nil }
        guard let content, let placement = resultPlacement() ?? overlay.placement else { return }
        overlay.showResult(content, at: placement, role: result.ok ? .toast : .error)
        scheduleResultEnd(after: Self.errorSeconds)
        publishStatus()
    }

    /// Another owner's toast took the slot: this one's goes, and its ⌘Z with it.
    func toastChanged() {
        guard let id = toastGrantID, arbiter.snapshot().toast?.id != id else { return }
        endResult(exit: 0.08)
    }

    private func resultPlacement() -> WritingOverlay.Placement? {
        if let caret = caretRect { return WritingOverlay.Placement(under: caret, x: caret.minX - 30, anchoredBy: "caret") }
        return overlay.placement
    }

    private func scheduleResultEnd(after seconds: TimeInterval) {
        resultTimer?.invalidate()
        resultTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.endResult(exit: 0.1) }
        }
    }

    private func endResult(exit: TimeInterval) {
        resultTimer?.invalidate()
        resultTimer = nil
        if let id = toastGrantID { arbiter.dismissToast(grantID: id) }
        toastGrantID = nil
        if overlay.role == .toast || overlay.role == .error { overlay.hidePanel(exit: exit) }
        // The debug state said "toast" until the next event (V1b, check 6's native case).
        publishStatus()
    }

    // MARK: - Gate and teardown

    /// Pause or the words role off: what is drawn goes, a check in flight is dropped.
    func gateClosed() {
        leaveField()
        endResult(exit: 0)
    }

    func shutdown() {
        gateClosed()
        checker.closeAll()
        overlay.hideAll()
    }

    // MARK: - Debug

    private func publishStatus(withBounds: Set<Int>? = nil) {
        var info = DebugState.WritingInfo()
        info.checks = checks
        info.lastCheck = lastCheck
        info.marks = marks.marks.enumerated().map { i, m in
            DebugState.WritingInfo.Mark(
                start: m.correction.span.start, end: m.correction.span.end, kind: m.correction.kind.rawValue,
                declined: m.declined, needsChoice: m.correction.needsChoice, hasBounds: withBounds?.contains(i) ?? false
            )
        }
        let drawn = overlay.debugInfo()
        info.underlines = drawn.underlines
        info.panel = drawn.panel
        info.panelRole = overlay.role?.rawValue
        info.anchoredBy = overlay.placement?.anchoredBy
        status.update { $0.writing = info }
    }
}
