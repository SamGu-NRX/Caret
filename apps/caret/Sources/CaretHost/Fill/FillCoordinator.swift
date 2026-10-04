import AppKit
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import CompletionUI
import Foundation

/// The screen side of `FillMachine`, which decides grounded fill: which proposal to offer in which
/// field, when to hold or withdraw it, the result toast and its ⌘Z. This class answers the
/// machine's reads from Accessibility, NSWorkspace and the window server, draws its commands with
/// `FillOverlay`, and sends its results to the helper. Every decision is the machine's and is
/// tested there (`FillMachineTests`).
@MainActor
final class FillCoordinator {
    private let machine: FillMachine
    private let world: FillWorldAdapter
    private let status: HostStatus
    private let overlay: FillOverlay
    private let watcher: FillTargetWatcher
    var executor: InsertionExecutor?
    var client: HelperClient?
    /// Called when this coordinator's toast took the arbiter's one toast slot, so another toast
    /// drawn for the slot (a fill pop-up's) can take itself down.
    var onToastShown: (() -> Void)?
    private var activationObserver: NSObjectProtocol?

    init(arbiter: OfferArbiter, status: HostStatus, overlay: FillOverlay, watcher: FillTargetWatcher, policy: TargetPolicy) {
        self.status = status
        self.overlay = overlay
        self.watcher = watcher
        let world = FillWorldAdapter(policy: policy)
        self.world = world
        machine = FillMachine(arbiter: arbiter, world: world, clock: RunLoopClock())
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        watcher.onChange = { [weak self] pid, at in self?.machine.fieldChanged(pid: pid, at: at) }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            MainActor.assumeIsolated { self?.machine.appActivated(pid: pid) }
        }
        overlay.onChange = { [weak self, weak overlay] in
            guard let self, let overlay else { return }
            let info = overlay.debugInfo()
            self.status.update { $0.fill.overlay = info }
        }
    }

    // MARK: - Events in, forwarded to the machine

    func receive(_ message: HelperInbound, at uptime: UInt64) {
        guard case .fillProposal(let proposal) = message else { return }
        machine.receive(proposal, at: uptime)
    }

    func displaced(_ offer: Offer) { machine.displaced(offer) }
    func memoryChanged(_ id: String) { machine.memoryChanged(id: id) }
    func offerChanged(_ reason: OfferArbiter.PassReason) { machine.offerChanged(reason) }
    func claimed(_ claim: Claim) { machine.claimed(claim) }
    func undoStarted(_ grant: UndoGrant) { machine.undoStarted(grant) }
    func toastChanged() { machine.toastChanged() }
    func gateClosed() { machine.gateClosed() }

    func insertionFinished(_ result: InsertionExecutor.Result) {
        machine.insertionFinished(FillInsertion(
            claim: result.claim, verified: result.insertion.verified == true, rejected: result.rejected,
            reason: result.reason, method: result.method, undo: result.undo,
            insertedLength: UTF16Text.length(result.claim.insertionText)
        ))
    }

    func undoFinished(_ result: InsertionExecutor.UndoResult) {
        machine.undoFinished(FillUndo(grant: result.grant, ok: result.ok, error: result.error))
    }

    func shutdown() {
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
        watcher.stop()
        machine.shutdown()
    }

    // MARK: - Carrying out the machine's commands

    private func perform(_ command: FillCommand) {
        switch command {
        case .watchApp(let pid): watcher.watch(pid)
        case .unwatchApp(let pid): watcher.unwatch(pid)
        case .drawOffer(let draw):
            let element = world.element(readID: draw.readID)
            overlay.showOffer(
                value: draw.value, fieldFrame: draw.field,
                style: element.map(FieldStyleProbe.style(of:)) ?? OverlayTextStyle(),
                caption: draw.caption, pid: draw.pid, outcome: draw.line,
                hasPlaceholder: !(element.flatMap { AXRead.string(kAXPlaceholderValueAttribute, on: $0) } ?? "").isEmpty
            )
        case .hideOffer(let byTyping): overlay.hideOffer(byTyping: byTyping)
        case .markWorking: overlay.markWorking()
        case .drawToast(let draw):
            overlay.showToast(
                FillOverlay.ToastKind(rawValue: draw.kind.rawValue) ?? .error, lead: draw.lead, text: draw.text,
                keycap: draw.keycap, field: draw.field, pid: draw.pid, source: draw.source
            )
        case .hideToast(let byTyping): overlay.hideToast(byTyping: byTyping)
        case .hideAll: overlay.hideAll()
        case .remember(let offerID, let bundleID):
            executor?.remember(offerID: offerID, context: TextFieldContext(
                beforeCursor: "", target: AppTarget(bundleIdentifier: bundleID, appName: "")
            ))
        case .toastSlotTaken: onToastShown?()
        case .send(let result): client?.send(result)
        case .offerShown(let trigger):
            let elapsedMs: (UInt64) -> Double = { Double(DispatchTime.now().uptimeNanoseconds &- $0) / 1_000_000 }
            switch trigger {
            case .proposal(let at): status.proposalToOffer.record(elapsedMs(at))
            case .focus(let at): status.focusToOffer.record(elapsedMs(at))
            case .other: break
            }
        case .count(let name): status.increment(name)
        case .publish:
            let info = machine.status
            status.update { info.apply(to: &$0.fill) }
        }
    }
}

/// The machine's reads, answered on the main thread. The last field read is kept so the drawing
/// layer can take the field's font and placeholder from the same element.
@MainActor
private final class FillWorldAdapter: FillWorld {
    private let policy: TargetPolicy
    private var lastRead: (id: UInt64, element: AXUIElement)?
    private var nextReadID: UInt64 = 1

    init(policy: TargetPolicy) { self.policy = policy }

    func element(readID: UInt64) -> AXUIElement? {
        lastRead.flatMap { $0.id == readID ? $0.element : nil }
    }

    nonisolated func allows(pid: Int32, bundleID: String?) -> Bool { policy.allows(pid: pid, bundleID: bundleID) }

    nonisolated func bundleID(pid: Int32) -> String? { NSRunningApplicationBundle.id(of: pid) }

    nonisolated func focusedField(pid: Int32) -> FillFieldRead? {
        MainActor.assumeIsolated {
            guard let (element, field) = FieldReader.readFocused(pid: pid), let frame = AXRead.frame(of: element) else { return nil }
            let id = nextReadID
            nextReadID &+= 1
            lastRead = (id, element)
            return FillFieldRead(identity: field.identity, value: field.value, selection: field.selection, secure: field.secure, frame: frame, readID: id)
        }
    }

    nonisolated func hold(for target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) -> SurfaceGate.Hold? {
        MainActor.assumeIsolated { Visibility.hold(for: target, anchors: anchors, requireFocus: requireFocus) }
    }

    /// The app is running and one of its windows has the source's title: SourceCheck's first test,
    /// without the walk for the value. Closed only when that is known: the process is gone, or every
    /// window's title was read and none matches. A read that fails or times out (a busy app) is
    /// unknown, and the value stays offered; SourceCheck rechecks it before the write.
    nonisolated func sourceOpen(_ source: FillOrigin.Window) -> Bool? {
        guard let pid = source.pid else { return nil }
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
        var list: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &list) == .success,
              let windows = list as? [AnyObject] else { return nil }
        var unread = false
        for item in windows where CFGetTypeID(item) == AXUIElementGetTypeID() {
            var title: CFTypeRef?
            guard AXUIElementCopyAttributeValue(unsafeBitCast(item, to: AXUIElement.self), kAXTitleAttribute as CFString, &title) == .success else {
                unread = true
                continue
            }
            if (title as? String) == source.title { return true }
        }
        return unread ? nil : false
    }
}

enum NSRunningApplicationBundle {
    static func id(of pid: pid_t) -> String? {
        NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    }
}
