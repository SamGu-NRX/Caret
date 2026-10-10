import Foundation

/// Holds a request for the helper while a restart that was just asked for is under way. Saving a Jev key restarts the
/// helper, which forgets the previews it minted; a preview asked for at once could reach the old helper as it stops,
/// and come back as an id the new one doesn't know, or get no reply at all (Codex on PR #17). The gate opens when the
/// connection has gone down and come back up, or after `waitLimit` if it never went down: some saves restart nothing
/// (a key from the environment, a helper Caret didn't launch).
public struct HelperRestartGate: Equatable, Sendable {
    /// No measurement behind it: a helper restart took about a second in the VM after-runs, and 10 s leaves room. A
    /// request that still finds no helper is retried by the flow (`OnboardingFlow.previewRetries`).
    public static let waitLimit: TimeInterval = 10

    private var since: TimeInterval?
    private var wentDown = false

    public init() {}

    /// A restart was asked for at `now`.
    public mutating func restartRequested(at now: TimeInterval) {
        since = now
        wentDown = false
    }

    public mutating func link(up: Bool) {
        guard since != nil else { return }
        if !up {
            wentDown = true
        } else if wentDown {
            since = nil
        }
    }

    /// Whether a request made at `now` waits.
    public func holds(at now: TimeInterval) -> Bool {
        guard let since else { return false }
        return now - since < Self.waitLimit
    }
}
