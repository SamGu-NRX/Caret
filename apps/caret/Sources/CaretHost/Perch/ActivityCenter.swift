import CaretHostCore
import CaretScreenCore
import CoreGraphics
import Foundation
import os

/// Where the activity center's requests go: the helper's socket, or a recorder in tests.
protocol ActivitySending: AnyObject, Sendable {
    func send(_ control: TaskControl) -> Bool
    func send(_ request: ActivityRequest) -> Bool
}

extension HelperClient: ActivitySending {}

/// Main-thread owner of the host's copy of the activity feed. Lists on every connect, applies
/// broadcasts, lists again on a gap, and sends the list's and the input pause's `taskControl`s.
@MainActor
final class ActivityCenter {
    private(set) var feed = ActivityFeed()
    let pauseGate = InputPauseGate()
    var client: ActivitySending?
    /// Called after every change to the records, the acknowledgement, or a row's busy state.
    var onChange: (() -> Void)?

    /// When the list was last opened, ms since 1970: a failure the user has seen stops holding
    /// the perch.
    private(set) var acknowledgedAt: Int64 = 0
    private var listRequests: Set<String> = []
    private var requestCount = 0
    /// Rows whose control is in flight, with the record's `updatedAt` when it was sent. A newer
    /// record for the task, or the timeout, frees the row.
    private var inFlight: [String: (updatedAt: Int64, sentAt: Date)] = [:]
    /// A control the helper never answers stops blocking its row after this long. Assumed.
    private let controlTimeout: TimeInterval = 3
    private var busyTimer: Timer?
    private(set) var stats = DebugActivity()

    struct DebugActivity: Codable, Equatable {
        var lists = 0
        var gaps = 0
        var controlsSent: [String] = []
        var controlsDropped = 0
        var inputPauses: [String] = []
    }

    var records: [TaskRecord] { feed.records }
    var busy: Set<String> { Set(inFlight.keys) }

    func rows(now: Date = Date()) -> [ActivityRow] { ActivityList.rows(feed.records, now: now) }

    func subject(now: Date = Date()) -> Perch.Subject? {
        Perch.subject(feed.records, now: now, acknowledgedAt: acknowledgedAt)
    }

    // MARK: - From the helper

    func linkChanged(_ up: Bool) {
        if up {
            requestList()
        } else {
            feed.reset()
            listRequests.removeAll()
            inFlight.removeAll()
            changed()
        }
    }

    func receive(_ message: HelperInbound) {
        switch message {
        case .activity(let activity):
            switch feed.apply(activity) {
            case .stale: return
            case .applied: break
            case .gap:
                stats.gaps += 1
                requestList()
            }
            if let sent = inFlight[activity.task.id], activity.task.updatedAt > sent.updatedAt { inFlight[activity.task.id] = nil }
            changed()
        case .activityReply(let reply):
            guard listRequests.remove(reply.requestId) != nil else { return }
            if feed.applyList(reply) {
                stats.lists += 1
                inFlight = inFlight.filter { id, sent in (feed.tasks[id]?.updatedAt ?? .max) <= sent.updatedAt }
                changed()
            }
        case .fillProposal, .error, .alternatives, .action, .popup, .offerWithdrawn, .taskProgress, .notForConsumer, .unknown:
            return
        }
    }

    private func requestList() {
        requestCount += 1
        let id = "host-list-\(requestCount)"
        listRequests.insert(id)
        if client?.send(ActivityRequest(requestId: id, op: .list)) != true { listRequests.remove(id) }
    }

    // MARK: - From the user

    /// A row's button. False when the helper is not connected or the row is already waiting on
    /// an answer.
    @discardableResult
    func control(_ taskId: String, _ action: RowAction) -> Bool {
        guard inFlight[taskId] == nil, let record = feed.tasks[taskId] else { return false }
        guard client?.send(TaskControl(taskId: taskId, action: action.control)) == true else {
            stats.controlsDropped += 1
            return false
        }
        stats.controlsSent.append("\(taskId):\(action.rawValue)")
        if stats.controlsSent.count > 20 { stats.controlsSent.removeFirst() }
        inFlight[taskId] = (record.updatedAt, Date())
        scheduleBusyTimeout()
        changed()
        return true
    }

    /// The list was opened: failures on screen until now have been seen.
    func acknowledge() {
        acknowledgedAt = Int64(Date().timeIntervalSince1970 * 1000)
        changed()
    }

    /// Called off the main thread by the input pause; records it for the debug socket.
    nonisolated func notePause(_ taskIds: [String], kind: String) {
        Task { @MainActor in
            self.stats.inputPauses.append(contentsOf: taskIds.map { "\($0):\(kind)" })
            if self.stats.inputPauses.count > 20 { self.stats.inputPauses.removeFirst(self.stats.inputPauses.count - 20) }
        }
    }

    /// Fires at the earliest outstanding control's deadline, so a later press on another row
    /// never extends an earlier one's wait.
    private func scheduleBusyTimeout() {
        busyTimer?.invalidate()
        busyTimer = nil
        guard let earliest = inFlight.values.map(\.sentAt).min() else { return }
        let wait = max(0.01, earliest.addingTimeInterval(controlTimeout).timeIntervalSinceNow)
        busyTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let cutoff = Date().addingTimeInterval(-self.controlTimeout + 0.01)
                let before = self.inFlight.count
                self.inFlight = self.inFlight.filter { $0.value.sentAt > cutoff }
                if self.inFlight.count != before { self.changed() }
                self.scheduleBusyTimeout()
            }
        }
    }

    private func changed() {
        pauseGate.update(feed.records, ownPID: ProcessInfo.processInfo.processIdentifier)
        onChange?()
    }
}

/// `InputPause` behind a lock, for the tap thread. The tap asks once per key, and once per click
/// only when some run is running; the answer costs a lock and a dictionary lookup.
final class InputPauseGate: @unchecked Sendable {
    private let state = OSAllocatedUnfairLock(initialState: InputPause())

    var isEmpty: Bool { state.withLock { $0.isEmpty } }

    func update(_ records: [TaskRecord], ownPID: Int32) {
        state.withLock { $0.update(records, ownPID: ownPID) }
    }

    func input(pid: Int32) -> [String] {
        state.withLock { $0.input(pid: pid) }
    }

    func snapshot() -> InputPause { state.withLock { $0 } }
}

/// Turns real input on the tap thread into pauses: keys carry their target pid; a click is
/// resolved to the app whose window is under it, off the tap thread.
final class InputPauser: @unchecked Sendable {
    private let gate: InputPauseGate
    private let send: @Sendable ([String], String) -> Void
    private let queue = DispatchQueue(label: "dev.caret.host.input-pause", qos: .userInitiated)
    private let ownPID = ProcessInfo.processInfo.processIdentifier

    init(gate: InputPauseGate, send: @escaping @Sendable ([String], String) -> Void) {
        self.gate = gate
        self.send = send
    }

    /// A real key-down headed for `pid`. Tap thread: a lock and a lookup, then enqueue.
    func key(pid: Int32) {
        guard pid != ownPID else { return }
        let ids = gate.input(pid: pid)
        guard !ids.isEmpty else { return }
        queue.async { [send] in send(ids, "key") }
    }

    /// A real mouse-down at a global, top-left-origin point. Tap thread: returns at once when no
    /// run is running; otherwise the window list is read on this class's queue.
    func click(at point: CGPoint) {
        guard !gate.isEmpty else { return }
        queue.async { [gate, send, ownPID] in
            // Caret's own windows count: a click on Continue in the list must not pause the run.
            guard let pid = SurfaceGate.topPID(at: point, windows: Visibility.windows(), ownPID: -1, displays: Self.displays()),
                  pid != ownPID else { return }
            let ids = gate.input(pid: pid)
            if !ids.isEmpty { send(ids, "mouse") }
        }
    }

    /// A click attributed to `pid` without a point: the debug socket's test hook.
    func click(pid: Int32) {
        guard pid != ownPID else { return }
        let ids = gate.input(pid: pid)
        if !ids.isEmpty { queue.async { [send] in send(ids, "mouse") } }
    }

    private static func displays() -> [CGRect] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    }
}
