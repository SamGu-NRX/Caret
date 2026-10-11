import Foundation

/// Whether the login item launchd was asked to start is running, read from `launchctl print gui/<uid>/dev.caret.host`
/// (H12).
///
/// Why the hand-off copy checks: in D1's VM run 4 (2eea5cf, 2026-10-06 00:41Z) `register()` succeeded and Background
/// Task Management listed the agent as enabled, but launchd never ran it. It stayed in `spawn scheduled` with
/// `last exit code = 78: EX_CONFIG`, 19 tries, while the copy the user opened had already exited. The person got no
/// Caret and no message. Four later runs of the same build, D1's harness included, spawned at once, so the cause is
/// not known. The copy now waits for the job to run, and when launchd keeps failing it runs Caret itself and says why.
public enum AgentStart {
    public struct Job: Equatable, Sendable {
        public var state: String?
        public var runs: Int
        /// `last exit code`, or nil while it reads "(never exited)".
        public var lastExit: String?
    }

    /// The fields of `launchctl print` this needs, from its text. Nil when there is no such job (empty output).
    public static func parse(_ print: String) -> Job? {
        guard !print.isEmpty else { return nil }
        func field(_ name: String) -> String? {
            for line in print.split(separator: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix(name + " = ") { return String(t.dropFirst(name.count + 3)) }
            }
            return nil
        }
        let exit = field("last exit code")
        return Job(state: field("state"), runs: Int(field("runs") ?? "") ?? 0, lastExit: exit == "(never exited)" ? nil : exit)
    }

    public enum Verdict: Equatable, Sendable {
        case running
        case wait
        /// launchd tried and the job did not stay up; the words are for the log.
        case failed(String)
    }

    /// `elapsed`: seconds since the copy registered or kickstarted the job. Two tries that ended, or `deadline` seconds
    /// with nothing running, count as failed. A first exit is allowed for, since launchd restarts a crash.
    public static let deadline: TimeInterval = 15

    public static func verdict(_ job: Job?, elapsed: TimeInterval) -> Verdict {
        if job?.state == "running" { return .running }
        if let job, job.runs >= 2, let exit = job.lastExit {
            return .failed("launchd tried \(job.runs) times and the job is \(job.state ?? "not running") (last exit code \(exit))")
        }
        guard elapsed >= deadline else { return .wait }
        guard let job else { return .failed("launchd has no \(LaunchRole.agentLabel) job \(Int(deadline)) s after it was registered") }
        return .failed("the job is \(job.state ?? "not running") \(Int(deadline)) s after it was registered (runs \(job.runs), last exit code \(job.lastExit ?? "none"))")
    }
}
