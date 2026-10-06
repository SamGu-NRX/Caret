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
    /// L1: v41's panel draws its own glass, so its crop can stand beside it in the same window.
    private let panel = HostedPanel(radius: LookShape.radius, popup: true, selfDrawn: true)
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
        // L1: and only it draws the source crop, so only it asks for the source's text.
        machine.drawsCrops = drawsOnScreen
        model.onAttach = { [weak self] step in
            self?.status.increment("pageTask.click")
            self?.machine.attachRequested(step: step)
        }
        // L1: the crop follows the pointer and VoiceOver. The panel stays click-through; the mouse-moved monitors say where
        // the pointer is, and the rows' frames say which row is under it.
        model.onVoiceFocus = { [weak self] step, on in self?.voiceFocus(step: step, on: on) }
        if drawsOnScreen { panel.onPointer = { [weak self] point in self?.pointer(at: point) } }
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
            pointerStep = nil
            voiceStep = nil
            hideCrop?.cancel()
            model.crop = nil
            // L1: once the panel has left, its content goes too, excerpts with it (review L1-1); a panel shown again is
            // drawn afresh from the machine.
            let gone = Motion.exit(motion == .exit ? Motion.Duration.toastExit : 0, reduce: Motion.reduceMotion) + 0.05
            DispatchQueue.main.asyncAfter(deadline: .now() + gone) { [weak self] in
                MainActor.assumeIsolated { if let self, !self.panel.isVisible { self.model.panel = nil } }
            }
            // A panel shown again is announced again, even with the same words (prep-for-prod H11-5).
            announced = ""
            panel.exit(duration: motion == .exit ? Motion.Duration.toastExit : 0)
        case .send(.accept(let accept)):
            if client?.send(accept) != true { status.increment("pageTask.acceptUnsent") }
        case .send(.control(let control)):
            if client?.send(control) != true { status.increment("pageTask.controlUnsent") }
        case .count(let name):
            status.increment(name)
            // A new task is placed at its own form, not where the task it replaced stood.
            if name == "pageTask.started" { placed = false }
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
        var info = DebugState.PageTaskInfo(status: machine.status, choosing: machine.choosing, filesWired: machine.filesWired, panel: panel.debugInfo(), lastAccept: machine.lastAccept)
        // L1: which row's crop shows and where; never the excerpt.
        info.crop = model.crop.map { step in
            DebugState.PageTaskInfo.Crop(step: step, side: model.side.rawValue, kind: model.panel.flatMap { PageTaskGroupView.line($0, key: step) }.map { $0.blank?.rawValue ?? $0.sourceKind?.rawValue ?? "none" } ?? "none")
        }
        if let panel = self.panel.debugInfo(), panel.frame.count == 4 {
            info.rows = model.geometry.rows.sorted { $0.key < $1.key }.map { step, r in
                .init(step: step, frame: [panel.frame[0] + r.minX, panel.frame[1] + r.minY, r.width, r.height].map { Double($0) })
            }
        }
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
        let crop = cropStep(content)
        switch motion {
        case .reveal where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Motion.Duration.enter)) { set(content, motion: motion, crop: crop, first: first) }
        case .crossfade where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Self.crossfade)) { set(content, motion: motion, crop: crop, first: first) }
        case .none:
            // A key moved nothing: not the rows, the rules, the crop or the figure (v41 5.4).
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { set(content, motion: motion, crop: crop, first: first) }
        default:
            // The helper's changes (a receipt, the ending) land at once; the rows' own rules, settles and the crop's marks
            // run their v41 motion (`PageTaskLook.motion`).
            set(content, motion: motion, crop: crop, first: first)
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
            // L1: the crop's side is chosen with the panel's place, so showing it never moves the panel: pinned at its
            // left edge when the crop goes right or over the rows, at its right edge when the crop goes left.
            let side = PageTaskLook.cropSide(panel: CGRect(origin: spot.origin, size: size), screen: screen, field: anchor.field)
            model.side = side
            let corner = CGPoint(x: side == .leading ? spot.origin.x + size.width : spot.origin.x, y: spot.origin.y)
            let pinned = Screen.cocoa(CGRect(origin: corner, size: CGSize(width: 1, height: 1)))
            panel.pin(HostedPanel.Anchor(corner: side == .leading ? .topRight : .topLeft, point: NSPoint(x: pinned.minX, y: pinned.maxY)))
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

    private func set(_ content: PageTaskPanel, motion: PageTaskMotion, crop: Int?, first: Bool) {
        model.animated = motion != .none
        model.cause = PageTaskLook.Cause(motion)
        model.stagger = first && motion == .enter
        model.panel = content
        model.crop = crop
    }

    // MARK: - The crop (L1)

    /// The row under the pointer, and the row VoiceOver is on.
    private var pointerStep: Int?
    private var voiceStep: Int?
    /// Leaving a row: the crop waits 150 ms before it goes, so moving to the next row keeps it (v41 3.4).
    private var hideCrop: DispatchWorkItem?
    static let leaveGrace: TimeInterval = 0.15

    /// The crop for the panel now (`PageTaskLook.cropStep`): the row being written while a group runs, else VoiceOver's
    /// row, else the pointer's.
    private func cropStep(_ content: PageTaskPanel) -> Int? {
        let running = machine.status.stage == "running" || machine.status.stage == "stopping"
        let writing = content.sections.last?.lines.first { $0.state == .writing }?.key
        return PageTaskLook.cropStep(running: running, writing: writing, voiceOver: voiceStep, pointer: pointerStep) {
            PageTaskGroupView.cropContent(content, key: $0) != nil
        }
    }

    private func pointer(at point: NSPoint) {
        guard panel.isVisible, model.panel != nil else { return }
        let f = panel.contentFrame(size: panel.size)
        let local = CGPoint(x: point.x - f.minX, y: f.maxY - point.y)
        let row = model.geometry.rows.first { $0.value.contains(local) }?.key
        let overCrop = model.geometry.crop.map { $0.contains(local) } ?? false
        if let row {
            hideCrop?.cancel()
            hideCrop = nil
            if row != pointerStep { pointerStep = row; refreshCrop() }
        } else if pointerStep != nil, !overCrop, hideCrop == nil {
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    self?.hideCrop = nil
                    self?.pointerStep = nil
                    self?.refreshCrop()
                }
            }
            hideCrop = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.leaveGrace, execute: work)
        } else if overCrop {
            hideCrop?.cancel()
            hideCrop = nil
        }
    }

    private func voiceFocus(step: Int, on: Bool) {
        if on { voiceStep = step } else if voiceStep == step { voiceStep = nil }
        refreshCrop()
    }

    /// Shows, moves or hides the crop for a pointer or VoiceOver change: `appear` from the anchor corner (opacity only
    /// under Reduce Motion), `leave` 100 ms linear. The window grows at once so the crop has room; it shrinks once the
    /// crop has left.
    private func refreshCrop() {
        guard let content = model.panel else { return }
        let next = cropStep(content)
        guard next != model.crop else { return }
        let was = model.crop
        let look = PageTaskLook.motion(.pointer, reduceMotion: Motion.reduceMotion)
        model.cause = .pointer
        if next != nil {
            withAnimation(was == nil ? CaretMotion.out(look.appear) : nil) { model.crop = next }
            remeasure()
        } else {
            withAnimation(CaretMotion.fade(100)) { model.crop = nil }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { [weak self] in
                MainActor.assumeIsolated { if self?.model.crop == nil { self?.remeasure() } }
            }
        }
        publish()
    }

    private func remeasure() {
        guard drawsOnScreen, panel.isVisible else { return }
        panel.setContent(PageTaskLiveView(model: model, character: FigureSettings.shared.character, animated: !Motion.reduceMotion))
        lastFrame = Screen.ax(panel.contentFrame(size: panel.size))
    }

    /// UI moment 5: the next page's content crosses over 200 ms.
    static let crossfade: Double = 0.2
}
