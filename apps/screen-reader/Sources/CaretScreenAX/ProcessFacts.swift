// What the kernel says about a process: when it started, which tells a process from a later one that reuses
// its pid (S1 audit #7), and the executable it runs, which tells a test fixture from anything else (S1 audit #10).
import Darwin
import Foundation

public enum ProcessFacts {
    /// The process's start time (kinfo_proc p_starttime) in microseconds since the epoch; nil when no process has this pid.
    public static func startMicros(_ pid: pid_t) -> Int64? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size == MemoryLayout<kinfo_proc>.stride, info.kp_proc.p_pid == pid else { return nil }
        let t = info.kp_proc.p_starttime
        return Int64(t.tv_sec) * 1_000_000 + Int64(t.tv_usec)
    }

    /// The full path of the process's executable; nil when it cannot be read.
    public static func executablePath(_ pid: pid_t) -> String? {
        // PROC_PIDPATHINFO_MAXSIZE, which the Swift overlay does not export.
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(decoding: buf.prefix(Int(n)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}
