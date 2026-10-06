import CaretBridgeXPC
import CaretHostCore
import CaretPageProtocol
import Foundation
import Security

/// Vends the Mach service caret-bridge connects to, and relays each accepted bridge to the helper's page.sock
/// (xpc-bridge-host spec, "What you call"). The relay and its rules are bridge/'s `BridgeListener` with the
/// production defaults of `HostRelayConfig`: every bridge must be the team's dev.caret.bridge and the child of a
/// browser in `BridgeTrust.browserRequirements`. Nothing here, no flag and no setting, relaxes them.
enum PageBridgeVendor {
    enum Outcome {
        case on(BridgeListener)
        case off(String)

        var summary: String {
            switch self {
            case .on: return "on: \(BridgeTrust.machService)"
            case .off(let why): return "off: \(why)"
            }
        }
    }

    /// Whether this process's code satisfies the requirement the bridge holds its host to. An ad hoc or other-team
    /// build fails it, and every bridge would refuse it ("the service is not the Caret host"), so it vends nothing.
    static func isTeamSigned() -> Bool {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(BridgeTrust.hostRequirement as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(me, [], requirement) == errSecSuccess
    }

    /// `extraBrowserRequirements` exists only in the acceptance build (`CARET_ACCEPTANCE_HOST`), which adds Chrome for
    /// Testing by cdhash; the shipped build always passes none.
    static func start(role: LaunchRole, pageSocket: String, pageKey: Data, extraBrowserRequirements: [String] = [],
                      log: @escaping @Sendable (String) -> Void) -> Outcome {
        guard isTeamSigned() else { return .off("this build is not team-signed") }
        guard role == .agent else { return .off("Caret was not started by launchd as its agent, so it cannot own \(BridgeTrust.machService)") }
        var config = HostRelayConfig(socketPath: pageSocket, pageKey: pageKey)
        if !extraBrowserRequirements.isEmpty {
            let browsers = BridgeTrust.browserRequirements + extraBrowserRequirements
            config.launchingBrowser = { ProcessTrust.launchingBrowser(of: $0, requirements: browsers) }
        }
        let listener = BridgeListener(listener: NSXPCListener(machServiceName: BridgeTrust.machService), config: config, log: log)
        listener.resume()
        return .on(listener)
    }

    /// The page key the helper derives from the launch secret (helper/src/engines/auth.ts).
    static func pageKey(launchSecret: Data) -> Data { Handshake.pageKey(launchSecret: launchSecret) }
}
