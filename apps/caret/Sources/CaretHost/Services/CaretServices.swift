import CaretBridgeXPC
import CaretHostCore
import Foundation

/// The processes Caret.app runs besides itself, and the page bridge service (H4). The app shell builds one from what
/// main.swift decided, starts it before the host runtime, and stops it after.
///
/// - `launch`: a built Caret.app with no helper socket named. Caret starts the bundled helper and caret-screen with
///   one launch secret (`ServiceLauncher`) and, as the launchd agent, vends the bridge service (`PageBridgeVendor`).
/// - `attached`: a helper socket was named (`--helper-socket`, `CARET_SCREEN_SOCKET`), as every acceptance script
///   does, or there is no bundled helper (`swift run`). Caret starts nothing and connects there, as before H4.
@MainActor
public final class CaretServices {
    public enum Mode {
        case launch(home: CaretHome, programs: Programs, role: LaunchRole)
        case attached(socket: String, why: String)
    }

    public struct Programs: Equatable, Sendable {
        public var node: String
        public var helperEntry: String
        public var reader: String

        /// Where scripts/build-app.sh puts them, inside `bundle` (Caret.app). Nil unless all three are there.
        public static func inBundle(_ bundle: URL) -> Programs? {
            let contents = bundle.appendingPathComponent("Contents")
            let p = Programs(
                node: contents.appendingPathComponent("Helpers/node").path,
                helperEntry: contents.appendingPathComponent(Self.helperEntryInResources).path,
                reader: contents.appendingPathComponent("Helpers/caret-screen").path
            )
            let fm = FileManager.default
            guard fm.isExecutableFile(atPath: p.node), fm.isExecutableFile(atPath: p.reader), fm.fileExists(atPath: p.helperEntry) else { return nil }
            return p
        }

        /// The helper's entry point under Contents (scripts/build-app.sh writes it there).
        public static let helperEntryInResources = "Resources/helper/main.mjs"
    }

    /// What the process does after main.swift has read its arguments.
    public enum Launch {
        /// This copy handed off to the launchd agent; exit with success.
        case exit(String)
        case run(Mode)
    }

    /// Decides the launch role (`LaunchRole`), hands off to the agent when that is the role, and picks the mode.
    /// `namedHelperSocket`: `--helper-socket` or `CARET_SCREEN_SOCKET`, when given. `legacyHelperSocket`: where a
    /// build without a bundled helper connects, as before H4.
    public nonisolated static func plan(home: CaretHome, namedHelperSocket: String?, legacyHelperSocket: String, bundle: URL,
                            environment: [String: String]) -> Launch {
        let facts = LaunchRole.Facts(
            agentMarker: environment[LaunchRole.agentMarker] == "1", parentIsLaunchd: getppid() == 1,
            openedByLaunchServices: environment[LaunchRole.launchServicesMarker] == "1",
            teamSigned: PageBridgeVendor.isTeamSigned(), homeOverridden: home.isOverride
        )
        var role = LaunchRole.decide(facts)
        if role == .handOffToAgent {
            switch LoginAgent.handOff() {
            case .handedOff(let why): return .exit(why)
            case .runHere(let why): role = .inProcess(reason: why)
            }
        }
        if let named = namedHelperSocket { return .run(.attached(socket: named, why: "a helper socket was named")) }
        guard let programs = Programs.inBundle(bundle) else {
            return .run(.attached(socket: legacyHelperSocket, why: "this build has no bundled helper; scripts/build-app.sh makes one"))
        }
        return .run(.launch(home: home, programs: programs, role: role))
    }

    public let mode: Mode
    private let launcher: ServiceLauncher?
    private var bridge: PageBridgeVendor.Outcome = .off("not started")
    /// Browsers trusted beside `BridgeTrust.browserRequirements`.
    let extraBrowserRequirements: [String]
    private let log: @Sendable (String) -> Void
    /// Called on main when anything the menu shows changes.
    public var onChange: (() -> Void)?

    /// `extraBrowserRequirements` is kept only by the acceptance build (`CARET_ACCEPTANCE_HOST`, which adds Chrome for
    /// Testing by cdhash for a run); the shipped build drops it, whoever passes it (H8 decision 2).
    public init(mode: Mode, extraBrowserRequirements: [String] = []) throws {
        self.mode = mode
        #if CARET_ACCEPTANCE_HOST
        self.extraBrowserRequirements = extraBrowserRequirements
        #else
        self.extraBrowserRequirements = []
        #endif
        let log: @Sendable (String) -> Void = { line in
            FileHandle.standardError.write(Data("[caret-host \(ISO8601DateFormatter().string(from: Date()))] \(line)\n".utf8))
        }
        self.log = log
        switch mode {
        case .launch(let home, let programs, _):
            launcher = try ServiceLauncher(programs: programs, home: home, log: log)
        case .attached:
            launcher = nil
        }
        launcher?.onChange = { [weak self] in self?.onChange?() }
    }

    /// The socket the host's helper client connects to.
    public var helperSocket: String {
        switch mode {
        case .launch(let home, _, _): return home.screenSocket
        case .attached(let socket, _): return socket
        }
    }

    public func start() {
        switch mode {
        case .attached(let socket, let why):
            log("services: attached to the helper at \(socket) (\(why)); Caret starts no helper or reader")
            bridge = .off("Caret did not start the helper, so it holds no launch secret")
        case .launch(let home, _, let role):
            guard let launcher else { return }
            log("services: starting the helper and the reader in \(home.root)")
            launcher.start()
            bridge = PageBridgeVendor.start(
                role: role, pageSocket: home.pageSocket,
                pageKey: launcher.pageKey(PageBridgeVendor.pageKey(launchSecret:)),
                extraBrowserRequirements: extraBrowserRequirements, log: log
            )
        }
        switch bridge {
        case .on: log("page bridge on: vending \(BridgeTrust.machService)")
        case .off(let why): log("page bridge off: \(why)")
        }
        onChange?()
    }

    public func stop() async {
        if case .on(let listener) = bridge { listener.invalidate() }
        await launcher?.stop()
    }

    /// Why the services stopped, for the menu's "Caret stopped. Restart"; nil while they run.
    public var stoppedReason: String? { launcher?.stopped }

    public func restart() { launcher?.restart() }

    /// The debug socket's `services` reply.
    public func report() -> String {
        var r: [String: Any] = ["bridge": bridge.summary]
        switch mode {
        case .attached(let socket, let why):
            r["mode"] = "attached"
            r["helperSocket"] = socket
            r["why"] = why
        case .launch(let home, _, let role):
            r["mode"] = "launch"
            r["home"] = home.root
            r["role"] = "\(role)"
            for (k, v) in launcher?.report() ?? [:] { r[k] = v }
        }
        let data = (try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

#if CARET_ACCEPTANCE_HOST
extension CaretServices {
    /// Acceptance build only: relay bridges to a harness's page.sock with the harness's launch secret, through the same
    /// vendor and relay as the agent. Keeps the listener for the life of the process. Returns the bridge summary.
    public static func acceptanceRelay(pageSocket: String, launchSecret: Data, browserRequirements: [String],
                                       environment: [String: String]) -> String {
        let role = LaunchRole.decide(.init(
            agentMarker: environment[LaunchRole.agentMarker] == "1", parentIsLaunchd: getppid() == 1,
            openedByLaunchServices: false, teamSigned: PageBridgeVendor.isTeamSigned(), homeOverridden: true
        ))
        let log: @Sendable (String) -> Void = { line in
            FileHandle.standardError.write(Data("[caret-host \(ISO8601DateFormatter().string(from: Date()))] \(line)\n".utf8))
        }
        let outcome = PageBridgeVendor.start(role: role, pageSocket: pageSocket, pageKey: PageBridgeVendor.pageKey(launchSecret: launchSecret),
                                             extraBrowserRequirements: browserRequirements, log: log)
        acceptanceListener = outcome
        if case .on = outcome { log("listening on \(BridgeTrust.machService)") }
        return outcome.summary
    }

    private static var acceptanceListener: PageBridgeVendor.Outcome?
}
#endif
