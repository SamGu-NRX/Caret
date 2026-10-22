import Foundation

/// Caret's shutdown, run once however it is asked for (Quit, SIGTERM, the hand-off to the login item), with every
/// caller waiting for it under a deadline. Before this, a second request while one was running was ignored and Quit
/// returned `.terminateLater` without ever replying: in beta.2's VM run a hand-off stuck on a killed reader left a
/// Caret that Quit could not end.
@MainActor
public final class ShutdownOnce {
    /// How long any caller waits for the runtime and the services to stop before going on regardless.
    nonisolated public static let deadline: TimeInterval = 5

    private var task: Task<Void, Never>?

    public init() {}

    /// A shutdown has been started.
    public var started: Bool { task != nil }

    /// Starts `body` unless a shutdown already runs. Returns whether this call started it.
    @discardableResult
    public func start(_ body: @escaping @MainActor () async -> Void) -> Bool {
        guard task == nil else { return false }
        task = Task { @MainActor in await body() }
        return true
    }

    /// Waits until the shutdown finishes or `deadline` seconds pass, whichever comes first. True when it finished.
    /// With no shutdown started, returns true at once.
    public func wait(deadline: TimeInterval = ShutdownOnce.deadline) async -> Bool {
        guard let task else { return true }
        let once = Once()
        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            Task { @MainActor in
                await task.value
                if once.claim() { done.resume(returning: true) }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
                if once.claim() { done.resume(returning: false) }
            }
        }
    }

    /// For `applicationShouldTerminate`: starts `body` unless a shutdown already runs, then calls `reply` exactly once,
    /// when the shutdown finishes or at the deadline. `reply` gets whether it finished in time.
    public func finish(deadline: TimeInterval = ShutdownOnce.deadline, body: @escaping @MainActor () async -> Void,
                       reply: @escaping @MainActor (Bool) -> Void) {
        start(body)
        Task { @MainActor in reply(await wait(deadline: deadline)) }
    }

    @MainActor
    private final class Once {
        private var claimed = false
        func claim() -> Bool {
            defer { claimed = true }
            return !claimed
        }
    }
}
