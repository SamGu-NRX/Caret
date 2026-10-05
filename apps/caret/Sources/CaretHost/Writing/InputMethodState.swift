import AppKit
import Carbon
import os

/// Whether the current keyboard input source can compose text (an input method such as Kotoeri or
/// Pinyin) rather than type each key's character (a layout such as ABC).
///
/// Accessibility does not expose an app's marked (uncommitted) text, so the range guard cannot see
/// a composition directly. While an input method is selected, a writing fix might replace text an
/// IME is still composing, so writing checks pause and every range edit is refused as `composing`.
/// Read on main (Text Input Sources must be), read from any thread.
final class InputMethodState: @unchecked Sendable {
    static let shared = InputMethodState()

    private let flag = OSAllocatedUnfairLock(initialState: false)
    private var observer: NSObjectProtocol?

    var composes: Bool { flag.withLock { $0 } }

    @MainActor func start() {
        refresh()
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
    }

    @MainActor func refresh() {
        let composes: Bool
        if let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
           let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) {
            let type = Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
            composes = type != (kTISTypeKeyboardLayout as String)
        } else {
            composes = false
        }
        flag.withLock { $0 = composes }
    }
}
