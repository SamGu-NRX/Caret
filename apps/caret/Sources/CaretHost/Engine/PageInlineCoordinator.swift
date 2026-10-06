import AppKit
import AutocompleteCore
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
    private var tabOwner: String?
    private var activation: NSObjectProtocol?

    init(arbiter: OfferArbiter, status: HostStatus, engine: GhostTextEngine, policy: TargetPolicy, drawsOnScreen: Bool) {
        self.arbiter = arbiter
        self.status = status
        self.engine = engine
        self.policy = policy
        self.drawsOnScreen = drawsOnScreen
        machine = PageInlineMachine(arbiter: arbiter, clock: RunLoopClock()) { text, size in
            (text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size)]).width
        }
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        SettingsStore.shared.observe { [weak self] _ in MainActor.assumeIsolated { self?.reconsider() } }
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
        machine.field(PageFocusSource.current(pid: pid), gate: gate(pid: pid))
        publish()
    }

    /// The user left the browser, or its page has no field: what is shown goes.
    func focusLeft() {
        lastField = nil
        machine.field(nil, gate: PageInlineMachine.Gate(allowed: false, settings: SettingsStore.shared.settings.pageInline))
        publish()
    }

    func offerChanged(_ reason: OfferArbiter.PassReason) {
        machine.offerChanged(reason)
        publish()
    }

    func claimed(_ claim: Claim) {
        machine.claimed(claim)
        publish()
    }

    func displaced(_ offer: Offer) { machine.displaced(offer) }
    func sourceOff(_ app: String, says: String) {
        machine.sourceOff(app, says: says)
        publish()
    }
    func replied(_ reply: PageInsertReply) {
        machine.replied(reply)
        publish()
    }

    func gateClosed() {
        machine.gateClosed()
        publish()
    }

    func shutdown() {
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        generation?.cancel()
        ghost.exit(duration: 0)
        notice.exit(duration: 0)
    }

    /// A settings change (pause, the words role, Caret turned on or off for a page): the field is decided again.
    private func reconsider() {
        guard let f = lastField, let pid = Int32(exactly: f.app.pid) else { return }
        arbiter.setPageTabOwner(pid: pid, owner: OtherTabOwners.pageOwner(f, settings: SettingsStore.shared.settings.pageInline))
        machine.field(PageFocusSource.current(pid: pid), gate: gate(pid: pid))
        publish()
    }

    private func gate(pid: Int32) -> PageInlineMachine.Gate {
        let allowed = engine.state == .ready && wordsAllowed() && (drawsOnScreen ? policy.allowsLive(pid: pid) : policy.allows(pid: pid, bundleID: nil))
        return PageInlineMachine.Gate(allowed: allowed, settings: SettingsStore.shared.settings.pageInline)
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
        let gateNanos = HostCoordinator.presentationGateNanos(lastGenerationMs: engine.lastGenerationMs)
        generation = Task { [weak self] in
            // As native ghost text: generation starts at once; the adaptive gate only delays the drawing (ADR-080).
            let gate = Task { try? await Task.sleep(nanoseconds: gateNanos) }
            let outcome: GhostTextEngine.Outcome
            do {
                outcome = try await engine.suggest(for: context)
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
