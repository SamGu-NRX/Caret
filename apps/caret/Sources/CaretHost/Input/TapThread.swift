import AutocompleteCore
import CaretHostCore
import CoreGraphics
import Foundation
import os

/// The host's only key tap, on its own thread with its own run loop.
///
/// Keeping the tap off the main run loop means a busy main thread (AX reads, overlay layout) cannot
/// delay the user's keystrokes or get the tap disabled by the system's timeout. The callback does
/// no Accessibility calls: it builds a `KeyStroke`, asks the `OfferArbiter`, and hands any claim or
/// dismissal to other queues through the closures below, which must only enqueue.
public final class TapThread: @unchecked Sendable {
    public struct Callbacks: Sendable {
        /// A plain Tab claimed the current offer. Runs on the tap thread; enqueue and return.
        public var claimed: @Sendable (Claim) -> Void
        /// The arbiter removed or shortened the offer, or closed the toast. Runs on the tap thread;
        /// enqueue and return.
        public var offerChanged: @Sendable (OfferArbiter.PassReason, KeyStroke) -> Void
        /// ⌘Z took the toast's grant. Runs on the tap thread; enqueue and return.
        public var undo: @Sendable (UndoGrant) -> Void
        /// Every user key-down, with its uptime in nanoseconds, for latency measurement.
        public var keyDown: @Sendable (UInt64) -> Void
        /// An arrow, Esc or Command-digit moved within the offer. Runs on the tap thread; enqueue.
        public var navigated: @Sendable (UInt64, OfferUI) -> Void
        /// Esc on a working line that has run 3 s. Runs on the tap thread; enqueue.
        public var stopWork: @Sendable (StatusLine) -> Void
        /// Every user key-down that names its target pid, before the arbiter sees it: real input
        /// in an app a run acts in pauses the run. Tap thread; a lock and a lookup, then enqueue.
        public var realKey: @Sendable (Int32) -> Void
        /// Every user mouse-down, at its global top-left-origin point, from a listen-only tap.
        /// Tap thread; enqueue.
        public var mouseDown: @Sendable (CGPoint) -> Void
        /// Esc closed this offer, called before `offerChanged(.closed)`: a question Esc declined is
        /// answered by its id, even if main has since drawn something else. Tap thread; enqueue.
        public var closedOffer: @Sendable (UInt64) -> Void
        /// A user key that types text (no ⌘ or ⌃), with the pid it goes to. Tap thread; enqueue.
        public var typed: @Sendable (Int32) -> Void

        public init(
            claimed: @escaping @Sendable (Claim) -> Void,
            offerChanged: @escaping @Sendable (OfferArbiter.PassReason, KeyStroke) -> Void,
            undo: @escaping @Sendable (UndoGrant) -> Void,
            keyDown: @escaping @Sendable (UInt64) -> Void,
            navigated: @escaping @Sendable (UInt64, OfferUI) -> Void = { _, _ in },
            stopWork: @escaping @Sendable (StatusLine) -> Void = { _ in },
            realKey: @escaping @Sendable (Int32) -> Void = { _ in },
            mouseDown: @escaping @Sendable (CGPoint) -> Void = { _ in },
            closedOffer: @escaping @Sendable (UInt64) -> Void = { _ in },
            typed: @escaping @Sendable (Int32) -> Void = { _ in }
        ) {
            self.closedOffer = closedOffer
            self.typed = typed
            self.claimed = claimed
            self.offerChanged = offerChanged
            self.undo = undo
            self.keyDown = keyDown
            self.navigated = navigated
            self.stopWork = stopWork
            self.realKey = realKey
            self.mouseDown = mouseDown
        }
    }

    private struct Stats {
        var running = false
        var keyDowns: UInt64 = 0
        var consumed: UInt64 = 0
        var timeoutRecoveries: UInt64 = 0
        var maxCallbackNanos: UInt64 = 0
        var recentCallbackNanos: [UInt64] = []
        var targetFromEvent: UInt64 = 0
        var targetMissing: UInt64 = 0
        var mouseDowns: UInt64 = 0
        var tabs: UInt64 = 0
        var tabsPassed: UInt64 = 0
        var hookKeys: UInt64 = 0
    }

    private let arbiter: OfferArbiter
    private let callbacks: Callbacks
    private let stats = OSAllocatedUnfairLock(initialState: Stats())
    /// Set on the tap thread; read from the main and socket threads, hence the lock.
    private let port = OSAllocatedUnfairLock<CFMachPort?>(uncheckedState: nil)
    private var tap: CFMachPort? { port.withLockUnchecked { $0 } }
    /// The listen-only mouse tap; nil when the system refused it. Clicks then never pause a run,
    /// and the debug state says so.
    private let mousePort = OSAllocatedUnfairLock<CFMachPort?>(uncheckedState: nil)
    private var runLoop: CFRunLoop?
    private var thread: Thread?

    /// Keys typed into an app while Caret writes a fix there (`KeyHold`).
    let keyHold: KeyHold

    init(arbiter: OfferArbiter, callbacks: Callbacks, keyHold: KeyHold = KeyHold()) {
        self.arbiter = arbiter
        self.callbacks = callbacks
        self.keyHold = keyHold
    }

    /// Creates the tap on a new thread and waits for it. False when the system refused the tap,
    /// which means Accessibility or Input Monitoring is missing.
    @discardableResult
    public func start() -> Bool {
        guard thread == nil else { return tap != nil }
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [unowned self] in
            self.runTapLoop(signal: ready)
        }
        thread.name = "dev.caret.host.tap"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
        ready.wait()
        return tap != nil
    }

    /// Creates the taps again when the system refused one at launch: a grant given later (in
    /// onboarding) does nothing for a tap that was never made. True when the key tap exists.
    @discardableResult
    public func restartIfRefused() -> Bool {
        let hasKey = tap != nil
        let hasMouse = mousePort.withLockUnchecked { $0 } != nil
        guard !(hasKey && hasMouse) else { return true }
        if thread != nil { stop() }
        port.withLockUnchecked { $0 = nil }
        mousePort.withLockUnchecked { $0 = nil }
        return start()
    }

    public func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let mouse = mousePort.withLockUnchecked({ $0 }) { CGEvent.tapEnable(tap: mouse, enable: false) }
        if let runLoop { CFRunLoopStop(runLoop) }
        thread = nil
    }

    public var isEnabled: Bool {
        guard let tap else { return false }
        return CGEvent.tapIsEnabled(tap: tap)
    }

    public func debugState() -> DebugState.Tap {
        let enabled = isEnabled
        // Copy under the lock and sort outside it, so a socket read never holds up the callback.
        let s = stats.withLock { $0 }
        let sorted = s.recentCallbackNanos.sorted().map { Double($0) / 1_000 }
        var tap = DebugState.Tap(
            running: s.running,
            enabled: enabled,
            keyDowns: s.keyDowns,
            consumed: s.consumed,
            timeoutRecoveries: s.timeoutRecoveries,
            maxCallbackMicros: Double(s.maxCallbackNanos) / 1_000,
            p99CallbackMicros: LatencyRecorder.percentile(sorted, 0.99),
            targetFromEvent: s.targetFromEvent,
            targetMissing: s.targetMissing,
            mouseTap: mousePort.withLockUnchecked { $0 } != nil,
            mouseDowns: s.mouseDowns
        )
        tap.tabs = s.tabs
        tap.tabsPassed = s.tabsPassed
        tap.hookKeys = s.hookKeys
        return tap
    }

    // MARK: - Tap thread

    private func runTapLoop(signal ready: DispatchSemaphore) {
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: Self.callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            ready.signal()
            return
        }
        Self.warmCallbackPath()
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        let loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        // Clicks are only observed, on a separate listen-only tap: it cannot hold up or swallow a
        // click, so the key tap's ownership rules stay the only ones that consume anything.
        let mouseMask = CGEventMask(1 << CGEventType.leftMouseDown.rawValue)
            | CGEventMask(1 << CGEventType.rightMouseDown.rawValue)
            | CGEventMask(1 << CGEventType.otherMouseDown.rawValue)
        var mouseSource: CFRunLoopSource?
        if let mouse = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
            eventsOfInterest: mouseMask, callback: Self.mouseCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) {
            mouseSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, mouse, 0)
            CFRunLoopAddSource(loop, mouseSource, .commonModes)
            CGEvent.tapEnable(tap: mouse, enable: true)
            mousePort.withLockUnchecked { $0 = mouse }
        }
        port.withLockUnchecked { $0 = tap }
        self.runLoop = loop
        stats.withLock { $0.running = true }
        ready.signal()
        CFRunLoopRun()
        CFRunLoopRemoveSource(loop, source, .commonModes)
        if let mouseSource { CFRunLoopRemoveSource(loop, mouseSource, .commonModes) }
        stats.withLock { $0.running = false }
    }

    /// Runs the callback's work once on this thread before the first real key, so lazy Swift
    /// metadata and lock setup are not paid inside a user's keystroke.
    private static func warmCallbackPath() {
        let scratch = OfferArbiter()
        if let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
            _ = scratch.handleKeyDown(KeyStroke(event: event))
        }
        _ = scratch.handleKeyDown(.tab)
    }

    private static let callback: CGEventTapCallBack = { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let owner = Unmanaged<TapThread>.fromOpaque(refcon).takeUnretainedValue()
        return owner.process(type: type, event: event)
    }

    private static let mouseCallback: CGEventTapCallBack = { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let owner = Unmanaged<TapThread>.fromOpaque(refcon).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let mouse = owner.mousePort.withLockUnchecked({ $0 }) { CGEvent.tapEnable(tap: mouse, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) != SynthesizedEventMarker.userData {
            owner.stats.withLock { $0.mouseDowns &+= 1 }
            owner.callbacks.mouseDown(event.location)
        }
        return Unmanaged.passUnretained(event)
    }

    private func process(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let started = DispatchTime.now().uptimeNanoseconds

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            stats.withLock { $0.timeoutRecoveries &+= 1 }
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        // Our own paste and typed keystrokes come back through the tap (ADR-039). They must
        // neither claim nor dismiss.
        if event.getIntegerValueField(.eventSourceUserData) == SynthesizedEventMarker.userData {
            return Unmanaged.passUnretained(event)
        }

        // No fallback for a key without a target pid: a cached frontmost app can be stale by the
        // time the key is delivered. Such a key takes nothing; the counter says how often it happens.
        let key = KeyStroke(event: event)
        stats.withLock { key.targetPID == nil ? ($0.targetMissing &+= 1) : ($0.targetFromEvent &+= 1) }
        if keyHold.take(event, pid: key.targetPID) {
            record(started: started)
            return nil
        }
        let disposition = routeKey(key, stampedAt: started)
        record(started: started)
        switch disposition {
        case .consume: return nil
        case .pass: return Unmanaged.passUnretained(event)
        case .passAsPlainTab:
            // Cotypist's ⌥Tab: the app receives the Tab the user meant, without Option.
            event.flags.remove(.maskAlternate)
            return Unmanaged.passUnretained(event)
        }
    }

    /// What the tap does with a key-down.
    enum Disposition: Equatable {
        case consume, pass
        /// Pass it on with the Option flag cleared (`OfferArbiter.PassReason.realTab`).
        case passAsPlainTab
    }

    /// Decides one key and hands the result on. True when the key is Caret's and must not reach
    /// the app. The tap callback calls this for every user key-down; the debug socket's test hook
    /// calls it with a constructed key, so tests exercise this exact path without a global event.
    ///
    /// Every key routed here is counted, from the tap or the hook (`fromHook`), so a run driven
    /// through the hook reads the same counters as one driven by real keys (A18, bug 18).
    @discardableResult
    public func route(_ key: KeyStroke, stampedAt uptimeNanos: UInt64 = DispatchTime.now().uptimeNanoseconds, fromHook: Bool = false) -> Bool {
        routeKey(key, stampedAt: uptimeNanos, fromHook: fromHook) == .consume
    }

    func routeKey(_ key: KeyStroke, stampedAt uptimeNanos: UInt64 = DispatchTime.now().uptimeNanoseconds, fromHook: Bool = false) -> Disposition {
        let disposition = decide(key, stampedAt: uptimeNanos)
        let consumed = disposition == .consume
        stats.withLock { s in
            s.keyDowns &+= 1
            if consumed { s.consumed &+= 1 }
            if fromHook { s.hookKeys &+= 1 }
            if key.isPlainTab {
                s.tabs &+= 1
                if !consumed { s.tabsPassed &+= 1 }
            }
        }
        return disposition
    }

    private func decide(_ key: KeyStroke, stampedAt uptimeNanos: UInt64) -> Disposition {
        callbacks.keyDown(uptimeNanos)
        if let pid = key.targetPID {
            callbacks.realKey(pid)
            if key.text != nil, !key.command, !key.control { callbacks.typed(pid) }
        }
        switch arbiter.handleKeyDown(key) {
        case .consume(let claim):
            callbacks.claimed(claim)
            return .consume
        case .undo(let grant):
            callbacks.undo(grant)
            return .consume
        case .closeToast:
            callbacks.offerChanged(.toastDismissed, key)
            return .consume
        case .navigate(let offerID, let ui):
            callbacks.navigated(offerID, ui)
            return .consume
        case .closeOffer(let offerID):
            callbacks.closedOffer(offerID)
            callbacks.offerChanged(.closed, key)
            return .consume
        case .stopWork(let line):
            callbacks.stopWork(line)
            return .consume
        case .closeStatus:
            callbacks.offerChanged(.statusDismissed, key)
            return .consume
        case .pass(.noOffer), .pass(.otherApp), .pass(.modifierOnly):
            return .pass
        case .pass(.realTab):
            callbacks.offerChanged(.realTab, key)
            return .passAsPlainTab
        case .pass(let reason):
            callbacks.offerChanged(reason, key)
            return .pass
        }
    }

    private func record(started: UInt64) {
        let elapsed = DispatchTime.now().uptimeNanoseconds &- started
        stats.withLock { s in
            s.maxCallbackNanos = max(s.maxCallbackNanos, elapsed)
            s.recentCallbackNanos.append(elapsed)
            if s.recentCallbackNanos.count > 512 { s.recentCallbackNanos.removeFirst(256) }
        }
    }
}

extension KeyStroke {
    /// Reads the key code, modifiers and typed text from a key-down. No Accessibility, no AppKit.
    init(event: CGEvent) {
        let flags = event.flags
        let command = flags.contains(.maskCommand)
        let control = flags.contains(.maskControl)
        // The window server stamps the receiving process on events it routes to a session tap.
        let target = event.getIntegerValueField(.eventTargetUnixProcessID)
        self.init(
            keyCode: event.getIntegerValueField(.keyboardEventKeycode),
            command: command,
            control: control,
            option: flags.contains(.maskAlternate),
            shift: flags.contains(.maskShift),
            text: (command || control) ? nil : Self.typedText(event),
            targetPID: target > 0 ? Int32(truncatingIfNeeded: target) : nil,
            isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        )
    }

    /// The plain text a key types, or nil for C0 controls, DEL and AppKit's private-use range for
    /// arrows and function keys (the same rule KeyType's acceptance tap uses).
    private static func typedText(_ event: CGEvent) -> String? {
        var chars = [UniChar](repeating: 0, count: 8)
        var length = 0
        event.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
        guard length > 0 else { return nil }
        let text = String(utf16CodeUnits: chars, count: length)
        guard let scalar = text.unicodeScalars.first else { return nil }
        if scalar.value < 0x20 || scalar.value == 0x7F || (0xF700...0xF8FF).contains(scalar.value) {
            return nil
        }
        return text
    }
}
