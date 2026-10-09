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
    /// A counter name for the debug state (`HostStatus.increment`) each time a subscription is
    /// refused or retried.
    var onNote: ((String) -> Void)?

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
    private var lastNotifiedAt: UInt64 = 0

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

    /// A key that types text went to `pid`. If the app is the one observed and nothing was heard
    /// from it within `silenceAfterKey`, the subscriptions are on an element that no longer reports:
    /// a Mac Catalyst text view that had focus while its app launched posted nothing to Caret while
    /// it took a typed sentence, though a fresh subscription to it hears every key (VM run
    /// 20261009T111919Z-40847). So they move to the focused element again, and it is read.
    func keyTyped(pid: pid_t) {
        guard running, pid == observedPID else { return }
        let typedAt = DispatchTime.now().uptimeNanoseconds
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.silenceAfterKey) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.running, self.observedPID == pid, self.lastNotifiedAt < typedAt else { return }
                self.onNote?("focus.observe.silentKey")
                self.observeFocusedElement()
                self.scheduleRead()
            }
        }
    }

    /// Assumed, not measured: long enough for a value notification to follow a key in the apps
    /// sampled, short enough that the first ghost is not much later than it would have been.
    static let silenceAfterKey: TimeInterval = 0.2

    /// Re-read now, for example after the host inserted text.
    func requestRead() { scheduleRead() }

    @objc private func appActivated(_ note: Notification) {
        retarget()
        scheduleRead()
    }

    // MARK: - Observer

    private func retarget(attempt: Int = 0) {
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
        var refused = [
            add(kAXFocusedUIElementChangedNotification, on: appElement, observer: created),
            add(kAXFocusedWindowChangedNotification, on: appElement, observer: created),
            // A moved or resized window moves the caret on screen without changing the text; the
            // coordinator re-pins visible ghost text on the resulting read.
            add(kAXWindowMovedNotification, on: appElement, observer: created),
            add(kAXWindowResizedNotification, on: appElement, observer: created),
        ].filter { $0 != .success }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        observedPID = pid
        refused += observeFocusedElement()
        for code in refused { onNote?("focus.observe.refused.\(code.rawValue)") }
        if observedElement == nil { onNote?("focus.observe.noElement") }
        if (!refused.isEmpty || observedElement == nil), attempt < Self.retryDelays.count {
            retry(pid, attempt: attempt)
        }
        if electron.ask(pid: pid, bundleURL: app.bundleURL) { settle(pid) }
    }

    /// An app that has only just launched can refuse the subscriptions, or have no focused element
    /// yet, when it activates; with nothing subscribed Caret would not hear its typing until the
    /// user left the app and came back. So the subscriptions are made again while it stays in front.
    /// The delays are assumed, not measured: the VM's Mac Catalyst fixture (run
    /// 20261009T104144Z-36771) got no focus read at all after `open`, and this is the first try at it.
    static let retryDelays: [TimeInterval] = [0.3, 1.0, 2.5]

    private func retry(_ pid: pid_t, attempt: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelays[attempt]) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.running, self.observedPID == pid,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                self.onNote?("focus.observe.retry")
                self.tearDown()
                self.retarget(attempt: attempt + 1)
                self.scheduleRead()
            }
        }
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

    /// Moves the per-element value and selection subscriptions to the currently focused element.
    /// Returns the errors of the subscriptions the element refused.
    @discardableResult
    private func observeFocusedElement() -> [AXError] {
        guard let observer else { return [] }
        if let previous = observedElement {
            for name in Self.elementNotifications {
                AXObserverRemoveNotification(observer, previous, name as CFString)
            }
        }
        observedElement = AXRead.focusedElement()
        guard let element = observedElement else { return [] }
        return Self.elementNotifications.map { add($0, on: element, observer: observer) }.filter { $0 != .success }
    }

    private func tearDown() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        observedPID = nil
        observedElement = nil
    }

    /// `.notificationAlreadyRegistered` counts as subscribed.
    private func add(_ name: String, on element: AXUIElement, observer: AXObserver) -> AXError {
        let result = AXObserverAddNotification(observer, element, name as CFString, Unmanaged.passUnretained(self).toOpaque())
        return result == .notificationAlreadyRegistered ? .success : result
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
        lastNotifiedAt = DispatchTime.now().uptimeNanoseconds
        if notification == kAXFocusedUIElementChangedNotification
            || notification == kAXFocusedWindowChangedNotification
            || notification == kAXUIElementDestroyedNotification {
            observeFocusedElement()
        }
        scheduleRead()
    }

    // MARK: - Reading

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
        if let element, AXRead.pid(of: element) == ownPID { return }
        let snapshot = element.flatMap(reader.snapshot(of:))
        onChange?(Change(snapshot: snapshot, element: element, notifiedAt: notifiedAt))
    }
}
