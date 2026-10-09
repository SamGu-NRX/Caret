import AppKit
import AutocompleteCore
import Carbon
import CaretHostCore
import CaretScreenCore
import QuartzCore
import SwiftUI

/// The screen side of `PageInlineMachine` (H13): inline text in a web page field from the local ghost engine. It
/// generates, measures and draws; every decision is the machine's (`PageInlineTests`).
///
/// Motion: none on the ghost. It follows every keystroke, so it appears, moves and goes at once, as native ghost text
/// does (KeyType's renderer has no animation either). The quiet line about a page's own suggestions enters as every
/// slip does (`HostedPanel.enter`, opacity only under Reduce Motion) and goes at once when a key takes it.
@MainActor
final class PageInlineCoordinator {
    let machine: PageInlineMachine
    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let engine: GhostTextEngine
    private let policy: TargetPolicy
    private let drawsOnScreen: Bool
    private let ghost = HostedPanel(radius: 0, material: false)
    private let notice = HostedPanel(radius: Tokens.Shape.slipRadius)
    var client: HelperClient?
    /// The settings allow ghost text: not paused, the words role on (`HostGate`).
    var wordsAllowed: () -> Bool = { true }

    private var generation: Task<Void, Never>?
    /// The key-down stamp each request was made under: a key after it means the field is moving again.
    private var requestedAt: [UInt64: HostStatus.KeyStamp] = [:]
    private var measuredKeySequence: UInt64 = 0
    private let latency = LatencyRecorder(capacity: 200)
    private let generationTimes = LatencyRecorder(capacity: 200)
    private var shownLength: Int?
    private var lastField: PageField?
    /// The web origin of the page the user types in, read once per page field (`BrowserPage.frontOrigin` walks
    /// Accessibility, too slow for every keystroke), for that site's personal instructions.
    private var origin: String?
    private var originFocus: String?

    private var tabOwner: String?
    private var activation: NSObjectProtocol?
    private var inputMethod: NSObjectProtocol?

    /// Brief item 5: spelling fixes in the same page fields (`PageWritingMachine`), checked by the system checker and
    /// drawn with the native writing line, under the page's caret.
    let writing: PageWritingMachine
    private let writingLine = WritingOverlay()
    private var writingLineShown = false
    private let checker = NativeChecker()
    private var checkTask: Task<Void, Never>?
    /// The checking language, as the native writing coordinator picks it; nil checks nothing.
    private let language = NativeChecker.checkingLanguage(
        preferred: Locale.preferredLanguages, available: NSSpellChecker.shared.availableLanguages
    )

    init(arbiter: OfferArbiter, status: HostStatus, engine: GhostTextEngine, policy: TargetPolicy, drawsOnScreen: Bool) {
        self.arbiter = arbiter
        self.status = status
        self.engine = engine
        self.policy = policy
        self.drawsOnScreen = drawsOnScreen
        writing = PageWritingMachine(arbiter: arbiter, clock: RunLoopClock())
        machine = PageInlineMachine(arbiter: arbiter, clock: RunLoopClock()) { text, size in
            (text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size)]).width
        }
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        writing.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        SettingsStore.shared.observe { [weak self] _ in MainActor.assumeIsolated { self?.reconsider() } }
        // H13 review: an input method switched on (Pinyin) or off decides the field again: nothing is offered while one
        // composes (PageInline.allowed), and what is shown goes.
        inputMethod = NotificationCenter.default.addObserver(forName: InputMethodState.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconsider() }
        }
        // Another app in front: the page field is no longer where typing goes, so its ghost and line go.
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                guard let self, let field = self.lastField, Int32(exactly: field.app.pid) != pid else { return }
                self.focusLeft()
            }
        }
    }

    // MARK: - Inputs

    /// A page field the helper reported. Only the browser in front counts; another browser's report changes nothing here.
    func pageField(_ field: PageField) {
        guard let pid = Int32(exactly: field.app.pid) else { return }
        let settings = SettingsStore.shared.settings.pageInline
        let owner = OtherTabOwners.pageOwner(field, settings: settings)
        arbiter.setPageTabOwner(pid: pid, owner: owner)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
        lastField = field
        tabOwner = owner
        // The token names the walked element in its document, so a navigation to another site re-reads the origin.
        let focus = "\(field.windowId)|\(field.key ?? "")|\(field.token ?? "")"
        if focus != originFocus {
            originFocus = focus
            origin = BrowserPage.frontOrigin()
        }
        let current = PageFocusSource.current(pid: pid)
        machine.field(current, gate: gate(pid: pid))
        writing.field(current, gate: writingGate(pid: pid))
        publish()
    }

    /// The user left the browser, or its page has no field: what is shown goes.
    func focusLeft() {
        lastField = nil
        origin = nil
        originFocus = nil
        machine.field(nil, gate: PageInlineMachine.Gate(allowed: false, contentEditable: false, settings: SettingsStore.shared.settings.pageInline))
        writing.gateClosed()
        publish()
    }

    func offerChanged(_ reason: OfferArbiter.PassReason) {
        machine.offerChanged(reason)
        writing.offerChanged(reason)
        publish()
    }

    func claimed(_ claim: Claim) {
        machine.claimed(claim)
        writing.claimed(claim)
        publish()
    }

    /// ↓, ↑ or a Command digit moved within a writing fix's line.
    func navigated(offerID: UInt64, ui: OfferUI) {
        writing.navigated(offerID: offerID, ui: ui)
    }

    func displaced(_ offer: Offer) {
        machine.displaced(offer)
        writing.displaced(offer)
    }
    func sourceOff(_ app: String, says: String) {
        machine.sourceOff(app, says: says)
        publish()
    }
    func replied(_ reply: PageInsertReply) {
        machine.replied(reply)
        writing.replied(reply)
        publish()
    }

    func gateClosed() {
        machine.gateClosed()
        writing.gateClosed()
        publish()
    }

    func shutdown() {
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        if let inputMethod { NotificationCenter.default.removeObserver(inputMethod) }
        inputMethod = nil
        generation?.cancel()
        checkTask?.cancel()
        checker.closeAll()
        ghost.exit(duration: 0)
        notice.exit(duration: 0)
        writingLine.hideAll()
    }

    /// A settings change (pause, the words role, Caret turned on or off for a page): the field is decided again.
    private func reconsider() {
        guard let f = lastField, let pid = Int32(exactly: f.app.pid) else { return }
        arbiter.setPageTabOwner(pid: pid, owner: OtherTabOwners.pageOwner(f, settings: SettingsStore.shared.settings.pageInline))
        let current = PageFocusSource.current(pid: pid)
        machine.field(current, gate: gate(pid: pid))
        writing.field(current, gate: writingGate(pid: pid))
        publish()
    }

    /// Inline text's gate without the model: a fix needs only the system checker.
    private func writingGate(pid: Int32) -> PageWritingMachine.Gate {
        let settings = SettingsStore.shared.settings
        let allowed = PageInline.allowed(settings, wordsAllowed: wordsAllowed(), engineReady: true,
                                         browserAllowed: (drawsOnScreen ? policy.allowsLive(pid: pid) : policy.allows(pid: pid, bundleID: nil)) && !AppSwitch.shared.isOff(pid: pid),
                                         composing: InputMethodState.shared.composes)
        let checks = language.flatMap { NativeChecker.supports($0) ? $0 : nil }
        return PageWritingMachine.Gate(allowed: allowed, contentEditable: settings.pageInlineContentEditable, settings: settings.pageInline, language: checks)
    }

    private func perform(_ command: PageWritingMachine.Command) {
        switch command {
        case .check(let c):
            guard let f = lastField, let pid = Int32(exactly: f.app.pid), let language else { return }
            let key = NativeChecker.FieldKey(pid: pid, windowID: f.windowId, elementID: f.key ?? "")
            checkTask?.cancel()
            checkTask = Task { [weak self, checker] in
                let outcome = await checker.check(c.value, sentence: c.span, language: language, field: key)
                guard let self, !Task.isCancelled, case .corrections(let found) = outcome else { return }
                self.writing.checked(c.id, found)
                self.publish()
            }
        case .drawLine(let offer, let caret):
            guard drawsOnScreen else { return }
            let entering = !writingLineShown
            writingLineShown = true
            writingLine.showOffer(offer, at: WritingOverlay.Placement(under: caret, x: caret.minX - 30, anchoredBy: "caret"), entering: entering)
            if entering { AccessibilityNotification.Announcement(offer.spokenLine).post() }
        case .hideLine:
            writingLineShown = false
            writingLine.hidePanel(exit: 0.08)
        case .send(let insert):
            if client?.send(insert) != true { status.increment("pageWriting.insert.unsent") }
        case .drawError(let content, let field): drawNotice(content, field: field, enters: true)
        case .hideError: notice.exit(duration: 0.22)
        case .count(let name): status.increment(name)
        }
    }

    private func gate(pid: Int32) -> PageInlineMachine.Gate {
        // Secure Event Input on anywhere (a password field focused, Terminal's Secure Keyboard Entry): no offers at all.
        let secureOK = ExcludedApps.allowsOffers(secureInputEnabled: IsSecureEventInputEnabled())
        let allowed = PageInline.allowed(SettingsStore.shared.settings, wordsAllowed: wordsAllowed() && secureOK, engineReady: engine.state == .ready,
                                         browserAllowed: (drawsOnScreen ? policy.allowsLive(pid: pid) : policy.allows(pid: pid, bundleID: nil)) && !AppSwitch.shared.isOff(pid: pid),
                                         composing: InputMethodState.shared.composes)
        let settings = SettingsStore.shared.settings
        return PageInlineMachine.Gate(allowed: allowed, contentEditable: settings.pageInlineContentEditable, settings: settings.pageInline)
    }

    // MARK: - Commands

    private func perform(_ command: PageInlineMachine.Command) {
        switch command {
        case .generate(let r): generate(r)
        case .cancel:
            generation?.cancel()
            generation = nil
        case .drawGhost(let text, let caret, let look): drawGhost(text, caret: caret, look: look)
        case .hideGhost:
            ghost.exit(duration: 0)
            shownLength = nil
        case .drawNotice(let content, let field, let enters): drawNotice(content, field: field, enters: enters)
        case .hideNotice: notice.exit(duration: 0)
        case .drawError(let content, let field): drawNotice(content, field: field, enters: true)
        case .hideError: notice.exit(duration: 0.22)
        case .send(let insert):
            if client?.send(insert) != true { status.increment("pageInline.insert.unsent") }
        case .settings(let s): SettingsStore.shared.update(source: .menu) { $0.pageInline = s }
        case .count(let name): status.increment(name)
        }
    }

    private func generate(_ r: PageInlineMachine.Request) {
        generation?.cancel()
        let stamp = status.lastKeyDown()
        requestedAt = [r.id: stamp]
        let context = TextFieldContext(beforeCursor: r.before, afterCursor: r.after, target: AppTarget(bundleIdentifier: r.bundleID, appName: r.appName))
        let engine = self.engine
        let origin = self.origin
        let gateNanos = HostCoordinator.presentationGateNanos(lastGenerationMs: engine.lastGenerationMs)
        generation = Task { [weak self] in
            // As native ghost text: generation starts at once; the adaptive gate only delays the drawing (ADR-080).
            let gate = Task { try? await Task.sleep(nanoseconds: gateNanos) }
            let outcome: GhostTextEngine.Outcome
            do {
                outcome = try await engine.suggest(for: context, origin: origin)
            } catch {
                gate.cancel()
                // H13 review: a failed generation ends its request, so the next report of the same text asks again.
                if !(error is CancellationError), let self { self.machine.generated(r.id, text: nil, why: "engineError") }
                return
            }
            await gate.value
            guard let self, !Task.isCancelled else { return }
            if let ms = engine.lastGenerationMs { self.generationTimes.record(ms) }
            // A key after the request: the field is moving, and its own report generates again.
            guard self.status.lastKeyDown().sequence == self.requestedAt[r.id]?.sequence else {
                return self.machine.generated(r.id, text: nil, why: "keyAfter")
            }
            // Secure input may have come on while the engine worked: checked again just before drawing.
            if case .suggestion = outcome, !ExcludedApps.allowsOffers(secureInputEnabled: IsSecureEventInputEnabled()) {
                return self.machine.generated(r.id, text: nil, why: "secureInput")
            }
            switch outcome {
            case .suggestion(let s):
                self.machine.generated(r.id, text: s.text)
                // Keystroke to a fresh suggestion drawn, as native ghost text is measured; a ghost typed through is
                // redrawn without the engine and is not counted.
                if self.machine.lastOutcome == "shown" {
                    self.recordLatency()
                    // prep-for-prod: a VoiceOver user hears that a suggestion is there and that Tab takes it. Fresh
                    // suggestions only, never a redraw while typing through, and only while VoiceOver runs.
                    if NSWorkspace.shared.isVoiceOverEnabled { AccessibilityNotification.Announcement(PageInlineCopy.spoken(s.text)).post() }
                }
            case .suppressed(let why): self.machine.generated(r.id, text: nil, why: why)
            }
            self.publish()
        }
    }

    /// The page's font is unknown to the host: the system font at the field's size, in its ink at ghost opacity.
    private func drawGhost(_ text: String, caret: CGRect, look: PageField.Look?) {
        shownLength = text.count
        ghost.text = text
        guard drawsOnScreen else { return }
        let view = PageGhostText(text: text, size: CGFloat(look?.fontSize ?? 13), darkField: look?.dark ?? false)
            .frame(height: caret.height)
        ghost.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX, y: Screen.cocoa(caret).maxY)))
        ghost.setContent(view)
        ghost.panel.alphaValue = 1
        ghost.panel.orderFrontRegardless()
    }

    /// Keystroke to the ghost's paint, once per key, as `HostCoordinator.recordPaintLatency` measures native text.
    private func recordLatency() {
        CATransaction.flush()
        let stamp = status.lastKeyDown()
        guard stamp.uptimeNanos > 0, stamp.sequence != measuredKeySequence else { return }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds &- stamp.uptimeNanos) / 1_000_000
        guard elapsed < 2_000 else { return }
        measuredKeySequence = stamp.sequence
        latency.record(elapsed)
    }

    private func drawNotice(_ content: LineContent, field: CGRect, enters: Bool) {
        notice.text = content.text
        guard drawsOnScreen else { return }
        let view = PageInlineNoticeView(content: content, character: FigureSettings.shared.character, animated: enters && !Motion.reduceMotion)
        let size = notice.measure(view)
        // Under the field, its left edge under the field's start, as the save line stands (AnswerSaveCoordinator).
        let screen = Screen.axVisibleFrame(around: field)
        let x = min(max(field.minX - FieldPanelPlacement.caretInset, screen.minX + FieldPanelPlacement.margin), screen.maxX - FieldPanelPlacement.margin - size.width)
        let below = field.maxY + FieldPanelPlacement.gap
        let y = below + size.height <= screen.maxY - FieldPanelPlacement.margin ? below : max(screen.minY + FieldPanelPlacement.margin, field.minY - FieldPanelPlacement.gap - size.height)
        let corner = Screen.cocoa(CGRect(x: x, y: y, width: 1, height: 1))
        notice.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: corner.minX, y: corner.maxY)))
        notice.setContent(view)
        if enters || !notice.isVisible { notice.enter() }
        AccessibilityNotification.Announcement(SlipSpeech.line(content)).post()
    }

    // MARK: - Debug state

    private func publish() {
        let f = lastField
        let info = DebugState.PageInlineInfo(
            last: machine.lastOutcome, shownLength: shownLength, notice: machine.noticeShowing, fieldRole: f?.role,
            beforeLength: f?.text.map { $0.before.utf16.count }, afterLength: f?.text.map { $0.after.utf16.count },
            ownSuggestions: f?.ownSuggestions?.rawValue, tabOwner: tabOwner, latency: latency.summary(), generation: generationTimes.summary()
        )
        status.update { $0.pageInline = info }
    }
}
