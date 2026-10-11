import CaretHostCore
import Foundation

/// The app's end of `RouteFollower` (H6): field reads in, routing contexts out to the helper, route
/// decisions in, and one answer for ghost text and the writing line. Main thread.
@MainActor
final class RouteLink {
    let follower: RouteFollower
    private let status: HostStatus
    /// Writes one context; false when the helper is not connected or did not take routing.
    var send: (RoutingContext) -> Bool = { _ in false }
    /// The answer may have changed: a decision applied, or a wait ran out. Ghost text and the
    /// writing line held for a decision look again.
    var onChange: [() -> Void] = []
    /// The last read was a sentence or paragraph the user just finished, routing on or off, so ghost
    /// latency after a breakpoint is measured the same way with both settings.
    private(set) var lastReadFinishedText = false
    private var last: (target: TargetIdentity, value: String)?
    private var waitTimer: Timer?

    init(status: HostStatus, enabled: Bool) {
        self.status = status
        follower = RouteFollower(enabled: enabled)
    }

    static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    func observe(_ field: FieldState?) {
        var finished = false
        if let field {
            var target = field.identity
            target.elementRevision = ""
            if let last, last.target == target {
                finished = RouteFollower.textBreakpoint(previous: last.value, value: field.value, selection: field.selection) != nil
            }
            last = (target, field.value)
        } else {
            last = nil
        }
        lastReadFinishedText = finished
        let read = field.map {
            RouteFollower.Read(target: $0.identity, value: $0.value, selection: $0.selection, composing: InputMethodState.shared.composes)
        }
        if let context = follower.observe(read, nowMs: Self.nowMs()) { deliver(context) }
        publish()
    }

    func receive(_ decision: RouteDecision) {
        let (receipt, follow) = follower.receive(decision, nowMs: Self.nowMs())
        if let follow { deliver(follow) }
        switch receipt {
        case .applied: status.increment("routing.applied.\(decision.outcome?.rawValue ?? "deciding")")
        case .dropped(let why): status.increment("routing.dropped.\(why.rawValue)")
        }
        publish()
        if receipt == .applied { changed() }
    }

    func linkChanged(up: Bool, routing: Bool) {
        follower.linkChanged(up: up, routing: routing, nowMs: Self.nowMs())
        publish()
        changed()
    }

    func setEnabled(_ on: Bool) {
        follower.setEnabled(on, nowMs: Self.nowMs())
        publish()
        changed()
    }

    /// What ambient help may do now. A wait schedules one look again when it runs out.
    func gate() -> RouteFollower.Gate {
        let gate = follower.gate(nowMs: Self.nowMs())
        if case .wait(let until) = gate { wake(at: until) }
        return gate
    }

    private func deliver(_ context: RoutingContext) {
        status.increment(send(context) ? "routing.contextSent" : "routing.contextDropped")
    }

    private func wake(at untilMs: Int64) {
        guard waitTimer == nil else { return }
        let seconds = max(0, Double(untilMs - Self.nowMs()) / 1000)
        waitTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.waitTimer = nil
                self?.publish()
                self?.changed()
            }
        }
    }

    private func changed() {
        waitTimer?.invalidate()
        waitTimer = nil
        for body in onChange { body() }
    }

    private func publish() {
        let info = follower.debugInfo(nowMs: Self.nowMs())
        status.update { $0.routing = info }
    }
}
