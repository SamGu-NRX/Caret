import CaretScreenCore
import Foundation

/// Real input pauses a run: any key or click the user makes in an app a run is acting in sends
/// `taskControl pause` for that run (plan section 3: "Take over is automatic"). The helper stops
/// the run at its next step boundary and the activity row says where it stopped.
///
/// Only runs pause. A watch observes a window the user owns, so the user's input there is
/// expected and changes nothing. Each run gets one pause per stretch of running: after the pause
/// is sent, more keys in the same app send nothing until the run is running again (Continue).
public struct InputPause: Equatable, Sendable {
    /// Running runs by the pid they act in.
    public private(set) var running: [Int32: Set<String>] = [:]
    /// Runs already sent a pause since they last started running.
    public private(set) var sent: Set<String> = []

    public init() {}

    public var isEmpty: Bool { running.isEmpty }

    /// Rebuilds the table from the feed. `ownPID` is Caret's: input in Caret's own panels (a
    /// click on Continue, for one) never pauses anything.
    public mutating func update(_ records: [TaskRecord], ownPID: Int32) {
        var table: [Int32: Set<String>] = [:]
        for r in records where r.state == .running && r.kind != .watch {
            guard let app = r.app else { continue }
            let pid = Int32(truncatingIfNeeded: app.pid)
            guard pid > 0, pid != ownPID else { continue }
            table[pid, default: []].insert(r.id)
        }
        running = table
        let live = Set(table.values.joined())
        sent.formIntersection(live)
    }

    /// The messages that pause `taskIds`. Each says the host saw the user's own input
    /// (`reason: input`), so the helper keeps the reader's wording for the pause when the reader
    /// saw the input too ("typing in 'Claim form'").
    public static func controls(for taskIds: [String]) -> [TaskControl] {
        taskIds.map { TaskControl(taskId: $0, action: .pause, reason: .input) }
    }

    /// One real key or click in `pid`. Returns the runs to pause now, sorted, and marks them sent.
    public mutating func input(pid: Int32) -> [String] {
        guard let ids = running[pid] else { return [] }
        let fresh = ids.subtracting(sent)
        sent.formUnion(fresh)
        return fresh.sorted()
    }
}
