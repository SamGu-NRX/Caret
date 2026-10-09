import AppKit
import ApplicationServices
import MacContextCapture

/// Watches the focused text field through Accessibility notifications and reports a fresh
/// KeyType `FocusedFieldSnapshot` whenever focus, value or selection changes.
///
/// Unlike KeyType's `AccessibilityContextTracker` it has no safety poll and installs no key tap of
/// its own: the host's only tap is `TapThread`, and apps that under-report notifications simply
/// get no suggestion. Notifications arrive on the main run loop; a burst (value plus selection for
/// one keystroke) is coalesced into one read `coalesceInterval` after the first notification.
@MainActor
final class FocusObserver {
    struct Change {
        let snapshot: FocusedFieldSnapshot?
        let element: AXUIElement?
        /// When the notification that triggered this read arrived.
        let notifiedAt: UInt64
    }

    var onChange: ((Change) -> Void)?

    private let reader = FocusedFieldReader()
    private let electron = ElectronAccess()
    private let ownPID = ProcessInfo.processInfo.processIdentifier
    private let coalesceInterval: TimeInterval
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var observedElement: AXUIElement?
    private var pendingSince: UInt64?
    private var running = false
    private(set) var notificationCount: UInt64 = 0

    init(coalesceInterval: TimeInterval = 0.008) {
        self.coalesceInterval = coalesceInterval
    }

    func start() {
        guard !running else { return }
        running = true
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(appActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        retarget()
        scheduleRead()
    }

    func stop() {
        guard running else { return }
        running = false
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        tearDown()
    }

    /// Re-read now, for example after the host inserted text.
    func requestRead() { scheduleRead() }

    @objc private func appActivated(_ note: Notification) {
        retarget()
        scheduleRead()
    }

    // MARK: - Observer

    private func retarget() {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ownPID else {
            // Our own menu or a vanished app: keep watching the previous target.
            return
        }
        let pid = app.processIdentifier
        if pid == observedPID, observer != nil {
            observeFocusedElement()
            return
        }
        tearDown()

        var created: AXObserver?
        guard AXObserverCreate(pid, Self.callback, &created) == .success, let created else { return }
        let appElement = AXUIElementCreateApplication(pid)
        var registered = add(kAXFocusedUIElementChangedNotification, on: appElement, observer: created)
        registered = add(kAXFocusedWindowChangedNotification, on: appElement, observer: created) && registered
        // A moved or resized window moves the caret on screen without changing the text; the
        // coordinator re-pins visible ghost text on the resulting read.
        add(kAXWindowMovedNotification, on: appElement, observer: created)
        add(kAXWindowResizedNotification, on: appElement, observer: created)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        observedPID = pid
        observeFocusedElement()
        if electron.ask(pid: pid, bundleURL: app.bundleURL) { settle(pid) }
        // An app still launching (or busy) can refuse the subscription or have no focused element yet. Without a retry
        // its focus and typing posted nothing to Caret for as long as it stayed frontmost: in the rig VM, a TextEdit
        // just opened gave no element and no notification while 45 keys were typed into it (DF1 run
        // 20261009T110741Z-22973, host.log "focus read"). Subscribe again, and look again, a few times.
        if !registered || observedElement == nil { resubscribe(pid, attempt: 0) }
    }

    /// An Electron app just asked for its tree builds it after this read. A field that already had
    /// focus posts no focus change when the tree appears, so look again a few times. The delays are
    /// assumed, not measured: a first guess at how long Electron takes, checked in the VM (brief item 2).
    static let settleDelays: [TimeInterval] = [0.15, 0.5, 1.5]

    private func settle(_ pid: pid_t) {
        for delay in Self.settleDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.running, self.observedPID == pid else { return }
                    self.observeFocusedElement()
                    self.scheduleRead()
                }
            }
        }
    }

    /// Delays before subscribing to an app again after its subscription or its focused element failed; assumed, not
    /// measured (an app's launch in the VM took about a second).
    static let resubscribeDelays: [TimeInterval] = [0.3, 1, 3, 8]

    private func resubscribe(_ pid: pid_t, attempt: Int) {
        guard attempt < Self.resubscribeDelays.count else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.resubscribeDelays[attempt]) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.running, self.observedPID == pid,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                if self.observedElement != nil { self.scheduleRead(); return }
                self.tearDown()
                self.retargetOnce(pid: pid, attempt: attempt + 1)
            }
        }
    }

    /// `retarget` for one retry: subscribes again and, if that still fails, schedules the next retry.
    private func retargetOnce(pid: pid_t, attempt: Int) {
        var created: AXObserver?
        guard AXObserverCreate(pid, Self.callback, &created) == .success, let created else { return resubscribe(pid, attempt: attempt) }
        let appElement = AXUIElementCreateApplication(pid)
        var registered = add(kAXFocusedUIElementChangedNotification, on: appElement, observer: created)
        registered = add(kAXFocusedWindowChangedNotification, on: appElement, observer: created) && registered
        add(kAXWindowMovedNotification, on: appElement, observer: created)
        add(kAXWindowResizedNotification, on: appElement, observer: created)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        observedPID = pid
        observeFocusedElement()
        scheduleRead()
        if !registered || observedElement == nil { resubscribe(pid, attempt: attempt) }
    }

    /// Moves the per-element value and selection subscriptions to the currently focused element.
    private func observeFocusedElement() {
        guard let observer else { return }
        if let previous = observedElement {
            for name in Self.elementNotifications {
                AXObserverRemoveNotification(observer, previous, name as CFString)
            }
        }
        observedElement = AXRead.focusedElement()
        if let element = observedElement {
            for name in Self.elementNotifications {
                add(name, on: element, observer: observer)
            }
        }
    }

    private func tearDown() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        observedPID = nil
        observedElement = nil
    }

    /// True when the subscription took, or was already there.
    @discardableResult
    private func add(_ name: String, on element: AXUIElement, observer: AXObserver) -> Bool {
        let rc = AXObserverAddNotification(observer, element, name as CFString, Unmanaged.passUnretained(self).toOpaque())
        return rc == .success || rc == .notificationAlreadyRegistered
    }

    private static let elementNotifications = [
        kAXValueChangedNotification,
        kAXSelectedTextChangedNotification,
        kAXUIElementDestroyedNotification,
    ]

    private static let callback: AXObserverCallback = { _, _, name, refcon in
        guard let refcon else { return }
        // The run-loop source is on the main run loop, so this runs on the main thread.
        let observer = Unmanaged<FocusObserver>.fromOpaque(refcon).takeUnretainedValue()
        let notification = name as String
        MainActor.assumeIsolated { observer.handle(notification) }
    }

    private func handle(_ notification: String) {
        notificationCount &+= 1
        if notification == kAXFocusedUIElementChangedNotification
            || notification == kAXFocusedWindowChangedNotification
            || notification == kAXUIElementDestroyedNotification {
            observeFocusedElement()
        }
        scheduleRead()
    }

    // MARK: - Reading

    /// The first reads, one line each in the host log: which app is frontmost and whose element the read returned. DF1
    /// found state.focus null in TextEdit in every VM run with Accessibility granted; this says where the read stops.
    private var traced = 0
    private func trace(_ element: AXUIElement?) {
        guard traced < 30 else { return }
        traced += 1
        let front = NSWorkspace.shared.frontmostApplication
        let owner = element.flatMap { AXRead.pid(of: $0) }
        let role = element.flatMap { AXRead.string(kAXRoleAttribute, on: $0) }
        let line = "caret: focus read \(traced): frontmost \(front?.bundleIdentifier ?? "none") (\(front?.processIdentifier ?? -1)), element pid \(owner.map(String.init) ?? "none"), role \(role ?? "none")\(owner == ownPID ? " (Caret's own, skipped)" : "")\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    private func scheduleRead() {
        guard running, pendingSince == nil else { return }
        pendingSince = DispatchTime.now().uptimeNanoseconds
        DispatchQueue.main.asyncAfter(deadline: .now() + coalesceInterval) { [weak self] in
            MainActor.assumeIsolated { self?.readNow() }
        }
    }

    private func readNow() {
        guard running, let notifiedAt = pendingSince else { return }
        pendingSince = nil
        let element = AXRead.focusedElement()
        trace(element)
        if let element, AXRead.pid(of: element) == ownPID { return }
        let snapshot = element.flatMap(reader.snapshot(of:))
        onChange?(Change(snapshot: snapshot, element: element, notifiedAt: notifiedAt))
    }
}
