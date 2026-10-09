import CaretHostCore
import Foundation

/// Keeps the local model loaded only while a feature that uses it is on (`ModelNeed`), and releases it when the last
/// one goes off (Codex on #13: the model loaded at launch even with Complete words off).
///
/// A load or a release takes seconds, so they run one at a time. A switch flipped meanwhile is applied when the
/// current one ends; the model ends up as the last flip asked, and a flip back before the current step ends costs
/// nothing more. A load that fails still counts as done: a later release clears the failure, and a later load tries
/// the file again.
@MainActor
final class ModelResidency {
    /// Whether the last finished step was a load.
    private(set) var loaded = false
    private var wanted = false
    private(set) var stopped = false
    private var work: Task<Void, Never>?
    private let load: @MainActor () async -> Void
    private let release: @MainActor () async -> Void

    init(load: @escaping @MainActor () async -> Void, release: @escaping @MainActor () async -> Void) {
        self.load = load
        self.release = release
    }

    /// Loads now if `store`'s settings need the model, and follows every later change to them.
    func follow(_ store: SettingsStore) {
        want(ModelNeed.wanted(store.settings))
        store.observe { [weak self] in self?.want(ModelNeed.wanted($0)) }
    }

    /// Whether a feature that uses the model is on now. Ignored after `stop`.
    func want(_ on: Bool) {
        guard !stopped else { return }
        wanted = on
        guard work == nil, wanted != loaded else { return }
        work = Task { [weak self] in await self?.settle() }
    }

    private func settle() async {
        while !stopped, wanted != loaded {
            if wanted {
                await load()
                loaded = true
            } else {
                await release()
                loaded = false
            }
        }
        work = nil
    }

    /// Returns once no load or release is running.
    func settled() async {
        while let work { await work.value }
    }

    /// Quit: no step starts after the one running, which is awaited. The engine's `shutdown` then frees what is loaded.
    func stop() async {
        stopped = true
        await settled()
    }
}

/// Counts the calls inside the model, so a release waits for the last one to leave. Main thread, like the engine.
@MainActor
final class InFlight {
    private(set) var count = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// Callers waiting in `drained`.
    var waiting: Int { waiters.count }

    func enter() { count += 1 }

    func leave() {
        precondition(count > 0, "InFlight.leave without enter")
        count -= 1
        guard count == 0 else { return }
        let ready = waiters
        waiters = []
        for waiter in ready { waiter.resume() }
    }

    /// Returns at once when no call is inside, else when the last one leaves.
    func drained() async {
        guard count > 0 else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
