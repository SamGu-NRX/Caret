// Which process, and which of the reader's workers for it, a window id belongs to (B22, S1 audit #7). A pid
// alone does not say: the system reuses pids, and the reader makes a new worker when an app it dropped comes
// back. Before B22 every worker numbered its windows from 1, so a replacement process with the same pid got
// the old "<pid>-1", and a grant or undo ledger entry for the old window matched the new one. Every window id
// now carries the process's start time and the worker's generation, so ids of different incarnations never
// meet; grants and the helper's ledger hold window ids, so they carry both too.
import Foundation

public struct ProcessIncarnation: Sendable, Equatable {
    public let pid: Int32
    /// The process's start time (kinfo_proc p_starttime), microseconds since the epoch.
    public let startMicros: Int64
    /// The reader's count of workers made so far when this one was, from 1: unique within one reader run.
    public let generation: Int

    public init(pid: Int32, startMicros: Int64, generation: Int) {
        self.pid = pid
        self.startMicros = startMicros
        self.generation = generation
    }

    /// The id of this incarnation's `n`th window: "<pid>-<start>-<generation>-<n>". The helper treats ids as
    /// opaque; the pid comes first only so a person reading a log can tell the app.
    public func windowId(_ n: Int) -> String {
        "\(pid)-\(startMicros)-\(generation)-\(n)"
    }
}
