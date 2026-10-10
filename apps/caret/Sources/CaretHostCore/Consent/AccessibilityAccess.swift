import Foundation

/// The rules around asking macOS for Accessibility, each with one right answer, so they are tested alone
/// (AccessibilityAccessTests). The host does the system calls.
public enum AccessibilityAccess {
    /// The pane, tried in order: Apple's long-standing address (still the one AltTab and Ice open on macOS 26 and 27),
    /// then the Settings extension's. The host opens the next one only when the one before did not open.
    public static let paneURLs = [
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!,
        URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility")!,
    ]

    /// What System Settings calls the list: macOS 27 renamed it "Device Control and Data Access" (Loop, AltTab).
    public static func paneName(osMajor: Int) -> String {
        osMajor >= 27 ? "Device Control and Data Access" : "Accessibility"
    }

    /// macOS's alert is what first puts Caret in the list; asked again it shows nothing, so after the first ask Caret
    /// only opens the pane (with the drag panel). `asked` is persisted (`OnboardingProgress.axAsked`).
    public static func shouldPrompt(asked: Bool, trusted: Bool) -> Bool {
        !trusted && !asked
    }

    /// Caret was granted under one code signature and now runs under another (an update re-signed it), so macOS shows
    /// its switch as on but no longer trusts it. Only then does Caret offer to reset its own entry.
    public static func isStale(grantedSignature: String?, currentSignature: String?, trusted: Bool) -> Bool {
        guard !trusted, let granted = grantedSignature, let current = currentSignature else { return false }
        return granted != current
    }

    public struct ResetRefused: Error, Equatable, CustomStringConvertible {
        public let bundleID: String
        public var description: String { "Caret resets only its own Accessibility entry, not \(bundleID)" }
    }

    /// `tccutil`'s arguments to remove Caret's own Accessibility entry: never another app's.
    public static func resetArguments(bundleID: String?) throws -> [String] {
        try resetArguments(service: "Accessibility", bundleID: bundleID)
    }

    /// The TCC services Caret may reset for itself: the ones its own entries can be under.
    public static let ownServices = ["Accessibility", "ListenEvent", "PostEvent"]

    /// `tccutil reset SERVICE dev.caret.host`, for one of `ownServices` and Caret's own bundle id only.
    public static func resetArguments(service: String, bundleID: String?) throws -> [String] {
        guard let bundleID, bundleID == "dev.caret.host" else { throw ResetRefused(bundleID: bundleID ?? "nil") }
        guard ownServices.contains(service) else { throw ResetRefused(bundleID: "\(bundleID) under \(service)") }
        return ["reset", service, bundleID]
    }

    /// What to reset before the switch step opens System Settings: each of Caret's services this process is not trusted
    /// for. An entry the running build is not trusted under can only be another build's (same bundle id, another
    /// signature, which macOS shows as "Caret", switched on) or nothing, so resetting it loses nothing, and the drag then
    /// adds an entry bound to this build. Loop does the same (research/R7, technique 6). Trusted: nothing.
    public static func resetsBeforeAsking(accessibility: Bool, listenEvents: Bool, postEvents: Bool) -> [String] {
        guard !accessibility else { return [] }
        return ["Accessibility"] + (listenEvents ? [] : ["ListenEvent"]) + (postEvents ? [] : ["PostEvent"])
    }

    /// How long after macOS's change notice the entry counts as stale if this Caret is still untrusted.
    public static let staleAfterNotice: TimeInterval = 2
}

/// When to read `AXIsProcessTrusted` after macOS says the list changed. `com.apple.accessibility.api` can arrive before
/// tccd has written the change, so the read waits `settle` (Loop waits 250 ms, Hammerspoon about the same); several
/// notices inside that wait make one read. A slow poll elsewhere stays as the backup.
public final class GrantDetection {
    public static let settle: TimeInterval = 0.2

    private let clock: SurfaceClock
    private let read: () -> Void
    private var pending: SurfaceTimer?
    public private(set) var reads = 0

    public init(clock: SurfaceClock, read: @escaping () -> Void) {
        self.clock = clock
        self.read = read
    }

    /// macOS posted that the Accessibility list (or any TCC entry) changed.
    public func changed() {
        guard pending == nil else { return }
        pending = clock.schedule(after: Self.settle, repeats: false) { [weak self] in
            guard let self else { return }
            self.pending = nil
            self.reads += 1
            self.read()
        }
    }

    public func cancel() {
        pending?.cancel()
        pending = nil
    }
}
