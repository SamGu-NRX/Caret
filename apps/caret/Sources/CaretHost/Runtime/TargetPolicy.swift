import AppKit
import CaretHostCore
import Darwin
import Foundation

/// When a process started, from the kernel. A pid can be reused by a new process; the pair of pid
/// and start time cannot, so a write bound to both can never reach a process that took the pid
/// over.
enum ProcessStart {
    static func of(_ pid: pid_t) -> UInt64? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
    }
}

/// Which processes the host may offer into and write into.
///
/// On a shared Mac a test run names exactly the pids it started (`CARET_ALLOW_PIDS`), and the
/// host then never draws over, takes a key from, or writes into anything else. The insertion queue
/// asks again immediately before every post, so a pid that exits (and could be reused) or was never
/// listed cannot receive an event.
struct TargetPolicy: Sendable {
    /// Nil means every app.
    var allowedBundleIDs: Set<String>?
    /// Nil means every pid.
    var allowedPIDs: Set<Int32>?

    /// Caret never offers into its own windows: onboarding's staged field handles its own Tab.
    static let ownPID = ProcessInfo.processInfo.processIdentifier

    func allows(pid: Int32, bundleID: String?) -> Bool {
        if pid == Self.ownPID { return false }
        if ExcludedApps.excludes(bundleID: bundleID) { return false }
        if let allowedPIDs, !allowedPIDs.contains(pid) { return false }
        if let allowedBundleIDs, !allowedBundleIDs.contains(bundleID ?? "pid:\(pid)") { return false }
        return true
    }

    /// The same check against the live process table: the pid must still be running.
    func allowsLive(pid: Int32) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
        return allows(pid: pid, bundleID: app.bundleIdentifier)
    }

    static func pids(from raw: String?) -> Set<Int32>? {
        guard let raw, !raw.isEmpty else { return nil }
        return Set(raw.split(separator: ",").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) })
    }

    /// `--allow-pids` and `CARET_ALLOW_PIDS` as the app shell reads them: every entry a positive pid, or why not. A
    /// missing or mistyped list must not quietly lift the restriction it was meant to set (CodeRabbit on PR #9).
    static func strictPids(_ raw: String?) -> Result<Set<Int32>, PidListError> {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return .failure(.empty) }
        var out = Set<Int32>()
        for part in raw.split(separator: ",", omittingEmptySubsequences: false) {
            let t = part.trimmingCharacters(in: .whitespaces)
            guard let pid = Int32(t), pid > 0 else { return .failure(.notAPid(t)) }
            out.insert(pid)
        }
        return .success(out)
    }

    enum PidListError: Error, Equatable, CustomStringConvertible {
        case empty
        case notAPid(String)

        var description: String {
            switch self {
            case .empty: return "needs a comma-separated list of pids"
            case .notAPid(let t): return "'\(t)' is not a pid"
            }
        }
    }
}
