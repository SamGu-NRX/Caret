import AppKit
import ApplicationServices
import os

/// The CGEvent tap that lets plain Tab accept a visible completion.
///
/// A CGEvent tap is the only way to stop the host app from also receiving the
/// key, which criterion 2 requires: an NSEvent monitor can observe Tab but not
/// suppress it, so the field would complete *and* indent. That power is why
/// everything here is written to fail open -- any doubt and the event is
/// returned untouched.
///
/// The callback runs on the tap's run loop, not the main thread, and the
/// window server disables a tap that takes too long. So the callback does no
/// AX calls, no allocation beyond a struct copy, and above all no network: it
/// reads a snapshot the main actor published earlier and returns. Everything
/// slow happens afterwards, hopped to the main actor.
final class InlineKeyTap {
    /// Decisions are handed to the main actor; the tap thread only routes.
    var onAccept: ((String) -> Void)?
    var onDismiss: ((InlineCancelReason) -> Void)?
    var onCancel: ((InlineCancelReason) -> Void)?
    var onSelectChoice: ((Int) -> Void)?
    /// Raised when macOS refuses or disables the tap, so the UI can say why
    /// Tab completion is not working instead of failing silently.
    var onUnavailable: ((InlineDisabledReason) -> Void)?

    /// The chord shown in the preview hint. Sourced here so the hint cannot
    /// drift from the key this tap actually claims.
    /// Shown by the preview owned by this path. Tab itself is claimed by
    /// TabCompletionsController, not here.
    static let acceptHint = "Tab"

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private let log = Logger(subsystem: "com.caret.app", category: "inline-key-tap")

    /// Read by the tap thread, written by the main actor. `os_unfair_lock` is
    /// used rather than a queue hop because the callback must not wait.
    private var lock = os_unfair_lock_s()
    private var context: InlineKeyContext = .inert

    func publish(_ context: InlineKeyContext) {
        os_unfair_lock_lock(&lock)
        self.context = context
        os_unfair_lock_unlock(&lock)
    }

    private func snapshot() -> InlineKeyContext {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return context
    }

    // MARK: - Lifecycle

    var isRunning: Bool { tap != nil }

    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        guard AXHelpers.isTrusted() else {
            onUnavailable?(.accessibilityDenied)
            return false
        }

        let mask = (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let tap = Unmanaged<InlineKeyTap>.fromOpaque(refcon).takeUnretainedValue()
            return tap.handle(type: type, event: event)
        }

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            // Creation fails when Input Monitoring has not been granted.
            onUnavailable?(.inputMonitoringDenied)
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.runLoopSource = source
        return true
    }

    func stop() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            self.tap = nil
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
            self.runLoopSource = nil
        }
        publish(.inert)
    }

    deinit { stop() }

    // MARK: - Callback

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // The window server disables a tap that ran long or was interrupted.
        // Re-enable rather than leaving the user with a dead Tab key.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }

        if type == .leftMouseDown || type == .rightMouseDown {
            // A click moves focus or the caret; either way the offer is stale.
            if snapshot().visibleProposalID != nil {
                deliver { self.onCancel?(.focusChanged) }
            }
            return Unmanaged.passUnretained(event)
        }

        if type == .flagsChanged {
            return Unmanaged.passUnretained(event)
        }

        guard type == .keyDown else { return Unmanaged.passUnretained(event) }

        let context = snapshot()
        // Cheapest possible exit for the overwhelmingly common case: no offer,
        // no choices, nothing to decide.
        if !context.interceptionEnabled || (context.visibleProposalID == nil && context.visibleChoiceCount == 0) {
            return Unmanaged.passUnretained(event)
        }

        let keyEvent = InlineKeyEvent(
            keyCode: event.getIntegerValueField(.keyboardEventKeycode),
            modifiers: Self.modifiers(from: event.flags),
            isAutorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        )

        switch InlineKeyRouter.decide(keyEvent, context: context) {
        case .passThrough:
            return Unmanaged.passUnretained(event)
        case .accept(let proposalID):
            deliver { self.onAccept?(proposalID) }
            return nil
        case .swallowDuplicate:
            return nil
        case .selectChoice(let index):
            deliver { self.onSelectChoice?(index) }
            return nil
        case .dismiss(let reason):
            deliver { self.onDismiss?(reason) }
            return Unmanaged.passUnretained(event)
        case .cancelAndPassThrough(let reason):
            deliver { self.onCancel?(reason) }
            return Unmanaged.passUnretained(event)
        }
    }

    /// Hop off the tap thread before doing anything that could take time.
    private func deliver(_ work: @escaping () -> Void) {
        DispatchQueue.main.async(execute: work)
    }

    static func modifiers(from flags: CGEventFlags) -> InlineModifiers {
        var result: InlineModifiers = []
        if flags.contains(.maskCommand) { result.insert(.command) }
        if flags.contains(.maskAlternate) { result.insert(.option) }
        if flags.contains(.maskControl) { result.insert(.control) }
        if flags.contains(.maskShift) { result.insert(.shift) }
        // maskAlphaShift (caps lock), maskSecondaryFn and the numeric-pad bit
        // are ignored on purpose: none of them changes what Tab means.
        return result
    }
}
