import ApplicationServices
import CaretScreenCore
import Foundation

/// Electron builds its accessibility tree only when a client asks, with `AXManualAccessibility` on the
/// app element. The reader asks each Electron app it adds (CaretScreenAX `ScreenReader`), but the host
/// reads the focused field itself (`FocusObserver`): with no reader running it would see nothing in
/// Slack or Notion, and with one it can read before the reader has asked. So the host asks too, by the
/// reader's rule (`AppFamily.setsManualAccessibility`: Electron only; Chromium browsers do not handle
/// the attribute), once per process. Asking twice is harmless. `AXEnhancedUserInterface` is never set:
/// it made Chromium replay typed keys (Screenpipe #3884).
@MainActor
final class ElectronAccess {
    private var asked: Set<pid_t> = []
    private let family: (URL) -> AppFamily
    private let set: (pid_t) -> AXError

    init(
        family: @escaping (URL) -> AppFamily = { AppClassifier.family(bundleURL: $0) },
        set: @escaping (pid_t) -> AXError = ElectronAccess.setManualAccessibility
    ) {
        self.family = family
        self.set = set
    }

    /// Asks the app for its tree if it is an Electron process not asked before. True when this call
    /// asked and the app accepted, so its tree is on its way and the caller should read again shortly.
    func ask(pid: pid_t, bundleURL: URL?) -> Bool {
        guard !asked.contains(pid), let bundleURL else { return false }
        asked.insert(pid)
        guard family(bundleURL).setsManualAccessibility else { return false }
        return set(pid) == .success
    }

    nonisolated static func setManualAccessibility(_ pid: pid_t) -> AXError {
        let app = AXUIElementCreateApplication(pid)
        // The reader's per-element timeout: a hung app must not hold the main thread.
        AXUIElementSetMessagingTimeout(app, 0.25)
        return AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }
}
