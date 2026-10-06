import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI
import UniformTypeIdentifiers

/// The screen side of `PageTaskMachine` (brief H11): draws the page task panel at the form, moves it as the
/// machine says, and sends what its keys took. Every decision is the machine's and is tested there
/// (`PageTaskTests`); this class only carries the commands out.
@MainActor
final class PageTaskCoordinator {
    let machine: PageTaskMachine
    private let status: HostStatus
    private let panel = HostedPanel(radius: Tokens.Shape.popupRadius, popup: true)
    private let model = PageTaskModel()
    private let drawsOnScreen: Bool
    private var placed = false
    private var announced = ""
    private var activationObserver: NSObjectProtocol?
    var client: HelperClient?
    /// The panel's toast took the arbiter's slot from another surface's.
    var onToastTaken: (() -> Void)?

    init(arbiter: OfferArbiter, status: HostStatus, drawsOnScreen: Bool) {
        self.status = status
        self.drawsOnScreen = drawsOnScreen
        machine = PageTaskMachine(arbiter: arbiter, clock: RunLoopClock())
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        // H14: only a host on screen can show an open panel, so only it may name goalFiles.
        machine.canChooseFiles = drawsOnScreen
        model.onAttach = { [weak self] step in
            self?.status.increment("pageTask.click")
            self?.machine.attachRequested(step: step)
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            MainActor.assumeIsolated {
                // Caret itself came to the front: its own open panel, or something else of Caret's (debug socket).
                if pid == ProcessInfo.processInfo.processIdentifier { self?.status.increment("pageTask.caretActivated") }
                self?.machine.appActivated(pid: pid)
                self?.publish()
            }
        }
    }

    func shutdown() {
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
        openPanel?.cancel(nil)
        openPanel = nil
        panel.exit(duration: 0)
    }

    private func perform(_ command: PageTaskCommand) {
        defer { publish() }
        switch command {
        case .draw(let content, let motion, let anchor): draw(content, motion: motion, anchor: anchor)
        case .hide(let motion):
            placed = false
            // A panel shown again is announced again, even with the same words (prep-for-prod H11-5).
            announced = ""
            panel.exit(duration: motion == .exit ? Motion.Duration.toastExit : 0)
        case .send(.accept(let accept)):
            if client?.send(accept) != true { status.increment("pageTask.acceptUnsent") }
        case .send(.control(let control)):
            if client?.send(control) != true { status.increment("pageTask.controlUnsent") }
        case .count(let name): status.increment(name)
        case .toastTaken: onToastTaken?()
        case .chooseFile(let choice): choose(choice)
        }
    }

    /// Test hook: see `HostedPanel.gatesPointer`.
    func setGatesPointer(_ on: Bool) { panel.gatesPointer = on }

    /// H14: the machine's state and the panel on screen, for the debug socket.
    func publish() {
        // The task let go of the open panel (Tab went out, another preview came, the task ended): it closes, so it can
        // answer for nothing (prep-for-prod H14-6).
        if machine.choosing == nil, let open = openPanel {
            openPanel = nil
            open.cancel(nil)
        }
        let info = DebugState.PageTaskInfo(status: machine.status, choosing: machine.choosing, filesWired: machine.filesWired, panel: panel.debugInfo(), lastAccept: machine.lastAccept)
        status.update { $0.pageTask = info }
    }

    // MARK: - The open panel (H14)

    /// The panel's frame on screen (global, top-left points) while it shows, else where it last stood: the line
    /// offering to keep a file stands under it.
    private(set) var lastFrame: CGRect?
    /// The open panel that is up, if any; one at a time.
    private var openPanel: NSOpenPanel?

    /// Opens the open panel for an attach row the user asked to fill. Caret comes to the front for it, as any app
    /// does for its own open panel; the user moves through it with the keys and pointer as anywhere on the Mac.
    /// Closing it, with a file or without, gives the foreground back to the browser the page is in.
    private func choose(_ choice: FileChoice) {
        openPanel?.cancel(nil)
        let open = NSOpenPanel()
        openPanel = open
        open.canChooseFiles = true
        open.canChooseDirectories = false
        open.allowsMultipleSelection = false
        open.prompt = "Choose"
        open.message = "Choose a file for '\(choice.label)'"
        if let types = Self.contentTypes(choice.accept) { open.allowedContentTypes = types }
        NSApp.activate(ignoringOtherApps: true)
        open.begin { [weak self] response in
            let url = response == .OK ? open.url : nil
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.openPanel === open { self.openPanel = nil }
                let current = self.machine.isCurrentChooser(choice.token)
                if let url, let file = Self.attachFile(url) {
                    self.machine.filePicked(token: choice.token, step: choice.step, file: file)
                } else {
                    self.machine.chooserClosed(token: choice.token)
                }
                self.publish()
                // The browser gets the foreground back from Caret's own open panel, and only from it: a panel closed
                // because the task moved on, or while the user is in another app, takes nothing from anyone.
                if current, NSApp.isActive, let browser = NSRunningApplication(processIdentifier: choice.browserPid) {
                    NSApp.yieldActivation(to: browser)
                    browser.activate()
                }
            }
        }
    }

    /// The file as the row shows it: its whole name and when it was last changed. Nothing is read from it.
    static func attachFile(_ url: URL) -> AttachFile? {
        guard url.isFileURL else { return nil }
        let modified = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        return AttachFile(path: url.path, name: url.lastPathComponent, edited: modified.map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) })
    }

    /// The open panel's types for a control's accept tokens: ".pdf" by extension, "application/pdf" by MIME type,
    /// "image/*" as the whole family. Nil (any file) when the control names none, or names one the Mac has no type
    /// for: a chooser that hides a file the page would take is worse than one that shows a file it may refuse.
    static func contentTypes(_ accept: AcceptTypes) -> [UTType]? {
        guard !accept.isEmpty else { return nil }
        var out: [UTType] = []
        for ext in accept.extensions {
            guard let t = UTType(filenameExtension: ext) else { return nil }
            out.append(t)
        }
        for mime in accept.mimeTypes {
            let family: [String: UTType] = ["image/*": .image, "audio/*": .audio, "video/*": .movie, "text/*": .text]
            // An unknown MIME type comes back as a dynamic type no file on disk carries: the panel would show nothing.
            guard let t = family[mime] ?? UTType(mimeType: mime), !t.isDynamic else { return nil }
            out.append(t)
        }
        return out
    }

    private func draw(_ content: PageTaskPanel, motion: PageTaskMotion, anchor: PageTaskAnchor) {
        let reduce = Motion.reduceMotion
        let first = !placed || !panel.isVisible
        switch motion {
        case .reveal where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Motion.Duration.enter)) { model.animated = true; model.panel = content }
        case .crossfade where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Self.crossfade)) { model.animated = true; model.panel = content }
        default:
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) {
                model.animated = motion != .none
                model.panel = content
            }
        }
        panel.text = content.spoken
        // H14: an attach row takes a click while the preview waits; otherwise the panel is click-through as before.
        panel.clickableContent = content.sections.contains { $0.lines.contains { $0.kind == .attach } }
        guard drawsOnScreen else { return }
        let character = FigureSettings.shared.character
        let view = PageTaskLiveView(model: model, character: character, animated: !reduce)
        if first {
            let size = panel.measure(PageTaskView(panel: content, character: character, animated: false))
            // Placed once, beside the form's first field or at the page's top edge; it stays there for the task.
            let screen = Screen.axVisibleFrame(around: anchor.field ?? anchor.viewport ?? CGRect(x: 0, y: 0, width: 1, height: 1))
            let spot = PageTaskPlacement.place(size: size, anchor: anchor, screen: screen)
            let topLeft = Screen.cocoa(CGRect(origin: spot.origin, size: CGSize(width: 1, height: 1)))
            panel.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: topLeft.minX, y: topLeft.maxY)))
            placed = true
        }
        panel.setContent(view)
        if motion == .none, !panel.isVisible {
            // A key or a click brought it back (the open panel closing): drawn at once (prep-for-prod H14-4).
            panel.show()
        } else if first || motion == .enter {
            panel.enter(scales: false, rises: true)
        }
        let f = panel.contentFrame(size: panel.size)
        lastFrame = Screen.ax(f)
        // VoiceOver hears the panel's sentence and keys when they change, not each row as it resolves.
        if content.announcement != announced {
            announced = content.announcement
            AccessibilityNotification.Announcement(content.announcement).post()
        }
    }

    /// UI moment 5: the next page's content crosses over 200 ms.
    static let crossfade: Double = 0.2
}
