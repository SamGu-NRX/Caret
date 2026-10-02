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
        add(kAXFocusedUIElementChangedNotification, on: appElement, observer: created)
        add(kAXFocusedWindowChangedNotification, on: appElement, observer: created)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        observedPID = pid
        observeFocusedElement()
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

    private func add(_ name: String, on element: AXUIElement, observer: AXObserver) {
        AXObserverAddNotification(observer, element, name as CFString, Unmanaged.passUnretained(self).toOpaque())
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
