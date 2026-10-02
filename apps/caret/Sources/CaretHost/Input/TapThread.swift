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

        public init(
            claimed: @escaping @Sendable (Claim) -> Void,
            offerChanged: @escaping @Sendable (OfferArbiter.PassReason, KeyStroke) -> Void,
            undo: @escaping @Sendable (UndoGrant) -> Void,
            keyDown: @escaping @Sendable (UInt64) -> Void
        ) {
            self.claimed = claimed
            self.offerChanged = offerChanged
            self.undo = undo
            self.keyDown = keyDown
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
    }

    private let arbiter: OfferArbiter
    private let callbacks: Callbacks
    private let stats = OSAllocatedUnfairLock(initialState: Stats())
    /// Set on the tap thread; read from the main and socket threads, hence the lock.
    private let port = OSAllocatedUnfairLock<CFMachPort?>(uncheckedState: nil)
    private var tap: CFMachPort? { port.withLockUnchecked { $0 } }
    private var runLoop: CFRunLoop?
    private var thread: Thread?

    public init(arbiter: OfferArbiter, callbacks: Callbacks) {
        self.arbiter = arbiter
        self.callbacks = callbacks
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

    public func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
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
        return DebugState.Tap(
            running: s.running,
            enabled: enabled,
            keyDowns: s.keyDowns,
            consumed: s.consumed,
            timeoutRecoveries: s.timeoutRecoveries,
            maxCallbackMicros: Double(s.maxCallbackNanos) / 1_000,
            p99CallbackMicros: LatencyRecorder.percentile(sorted, 0.99),
            targetFromEvent: s.targetFromEvent,
            targetMissing: s.targetMissing
        )
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
        port.withLockUnchecked { $0 = tap }
        self.runLoop = loop
        stats.withLock { $0.running = true }
        ready.signal()
        CFRunLoopRun()
        CFRunLoopRemoveSource(loop, source, .commonModes)
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
        let consumed = route(key, stampedAt: started)
        record(started: started, consumed: consumed)
        return consumed ? nil : Unmanaged.passUnretained(event)
    }

    /// Decides one key and hands the result on. True when the key is Caret's and must not reach
    /// the app. The tap callback calls this for every user key-down; the debug socket's test hook
    /// calls it with a constructed key, so tests exercise this exact path without a global event.
    @discardableResult
    public func route(_ key: KeyStroke, stampedAt uptimeNanos: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Bool {
        callbacks.keyDown(uptimeNanos)
        switch arbiter.handleKeyDown(key) {
        case .consume(let claim):
            callbacks.claimed(claim)
            return true
        case .undo(let grant):
            callbacks.undo(grant)
            return true
        case .closeToast:
            callbacks.offerChanged(.toastDismissed, key)
            return true
        case .pass(.noOffer), .pass(.otherApp):
            return false
        case .pass(let reason):
            callbacks.offerChanged(reason, key)
            return false
        }
    }

    private func record(started: UInt64, consumed: Bool) {
        let elapsed = DispatchTime.now().uptimeNanoseconds &- started
        stats.withLock { s in
            s.keyDowns &+= 1
            if consumed { s.consumed &+= 1 }
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
            targetPID: target > 0 ? Int32(truncatingIfNeeded: target) : nil
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
