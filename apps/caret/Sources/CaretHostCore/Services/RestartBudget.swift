import Foundation

/// The crash rule for the services Caret.app starts (helper/src/launch.ts, B23): a service that exits on its own is
/// started again with the same launch secret, at most `limit` times in any `window`; one more exit inside the window
/// stops Caret and shows "Caret stopped. Restart" instead of looping.
public struct RestartBudget: Equatable, Sendable {
    /// launch.ts's RESTARTS and RESTART_WINDOW_MS. Assumed there, kept here so both launchers behave alike.
    public static let defaultLimit = 5
    public static let defaultWindow: TimeInterval = 60
    /// launch.ts's RESTART_DELAY_MS. Assumed: the reader retries its connection every second.
    public static let restartDelay: TimeInterval = 1

    public enum Decision: Equatable, Sendable {
        /// Start the service again after `after` seconds, with the same secret.
        case restart(after: TimeInterval)
        /// The service exited `exits` times within the window: stop everything.
        case stop(exits: Int)
    }

    public let limit: Int
    public let window: TimeInterval
    /// Monotonic times of the restarts still inside the window, oldest first.
    public private(set) var restarts: [TimeInterval] = []

    public init(limit: Int = RestartBudget.defaultLimit, window: TimeInterval = RestartBudget.defaultWindow) {
        precondition(limit >= 0 && window > 0, "a restart budget needs a limit of at least 0 and a positive window")
        self.limit = limit
        self.window = window
    }

    /// The service exited on its own at monotonic time `now` (seconds).
    public mutating func exited(at now: TimeInterval) -> Decision {
        restarts.removeAll { now - $0 > window }
        if restarts.count >= limit { return .stop(exits: restarts.count + 1) }
        restarts.append(now)
        return .restart(after: Self.restartDelay)
    }

    /// The user chose Restart: the count starts again.
    public mutating func reset() { restarts.removeAll() }
}
