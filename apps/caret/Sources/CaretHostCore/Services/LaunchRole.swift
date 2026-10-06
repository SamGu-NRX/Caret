import Foundation

/// What this Caret process is, decided once at launch (H4, lead decision 2).
///
/// Caret runs as a launchd agent registered with `SMAppService.agent`, because only a launchd job can own the Mach
/// service the page bridge connects to. The agent's plist marks its process (`CARET_LAUNCHD_AGENT=1`). A copy the user
/// opens from Finder registers the agent, or starts it, and exits. Anything else runs in-process without the bridge.
///
/// Registering adds a login item and starts a background process, so it happens only in the one case that is the
/// user's own Caret: LaunchServices opened a team-signed build that was given no home of its own. LaunchServices
/// marks its launches through Info.plist's LSEnvironment (`CARET_OPENED_BY_LAUNCHSERVICES=1`); a parent of pid 1 alone
/// is not enough, since a directly started process whose parent exits is reparented to launchd too (H4 review). A copy
/// started from a shell or a test, a debug build, or a run with `--home` never registers.
public enum LaunchRole: Equatable, Sendable {
    /// launchd started this process for the agent's job: vend the bridge service.
    case agent
    /// The user opened Caret.app: hand off to the agent (register it, or start it) and exit.
    case handOffToAgent
    /// Run the whole host in this process, without the page bridge; `reason` says why, for the log.
    case inProcess(reason: String)

    public struct Facts: Equatable, Sendable {
        /// The agent plist's marker is in the environment.
        public var agentMarker: Bool
        /// The parent process is launchd (pid 1) at launch: LaunchServices or launchd started this process.
        public var parentIsLaunchd: Bool
        /// Info.plist's LSEnvironment marker is in the environment: LaunchServices opened this copy.
        public var openedByLaunchServices: Bool
        /// The running code satisfies the host requirement the bridge holds it to (team-signed dev.caret.host).
        public var teamSigned: Bool
        /// The run named its own Caret home.
        public var homeOverridden: Bool

        public init(agentMarker: Bool, parentIsLaunchd: Bool, openedByLaunchServices: Bool, teamSigned: Bool, homeOverridden: Bool) {
            self.agentMarker = agentMarker
            self.parentIsLaunchd = parentIsLaunchd
            self.openedByLaunchServices = openedByLaunchServices
            self.teamSigned = teamSigned
            self.homeOverridden = homeOverridden
        }
    }

    /// The environment variable the agent's plist sets. It decides only whether this process tries to vend the
    /// service; it grants nothing, since launchd hands the service only to the job that lists it and the bridge
    /// still holds whatever answers to the host requirement.
    public static let agentMarker = "CARET_LAUNCHD_AGENT"
    /// The agent's launchd label (Bundle/dev.caret.host.plist).
    public static let agentLabel = "dev.caret.host"
    /// The environment variable Info.plist's LSEnvironment sets for a copy LaunchServices opens.
    public static let launchServicesMarker = "CARET_OPENED_BY_LAUNCHSERVICES"

    public static func decide(_ f: Facts) -> LaunchRole {
        if f.agentMarker {
            // launchd sets the marker only for the agent's job, whose parent is launchd.
            return f.parentIsLaunchd ? .agent : .inProcess(reason: "\(agentMarker) is set but launchd did not start this process")
        }
        guard f.openedByLaunchServices, f.parentIsLaunchd else { return .inProcess(reason: "started directly, not opened by LaunchServices") }
        guard f.teamSigned else { return .inProcess(reason: "this build is not team-signed") }
        guard !f.homeOverridden else { return .inProcess(reason: "this run has its own Caret home") }
        return .handOffToAgent
    }
}
