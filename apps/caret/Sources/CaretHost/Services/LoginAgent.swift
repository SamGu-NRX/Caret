import CaretHostCore
import Foundation
import ServiceManagement

/// Caret's launchd agent, registered with SMAppService from Contents/Library/LaunchAgents/dev.caret.host.plist
/// (H4, lead decision 2). Once registered, Caret starts at login. `Caret --unregister` and the menu's "Stop Opening at
/// Login" remove it (H12).
///
/// `handOff` is called only for `LaunchRole.handOffToAgent`: a team-signed Caret.app that LaunchServices opened with no
/// home of its own. `register()` adds a login item and starts a process, so nothing else may reach it.
public enum LoginAgent {
    static let plistName = "dev.caret.host.plist"
    static let label = "dev.caret.host"

    /// The part of `SMAppService` the unregister path uses, so a test can stand in for the system: registering or
    /// unregistering on a developer's Mac changes their real login items.
    public protocol Service {
        var status: SMAppService.Status { get }
        func unregister() throws
    }

    /// The agent's SMAppService. Only the shipped paths (`--unregister`, the menu) construct it.
    public static func system() -> Service { SMAppService.agent(plistName: plistName) }

    enum HandOff: Equatable {
        /// The agent is registered and running, or was just started: this copy exits.
        case handedOff(String)
        /// Run here instead, without the page bridge.
        case runHere(String)
    }

    static func handOff() -> HandOff {
        let service = SMAppService.agent(plistName: plistName)
        switch service.status {
        case .enabled:
            // Registered already; the user quit it (exit 0 keeps launchd from restarting it). Start it again.
            return kickstart()
        case .requiresApproval:
            return .runHere("Caret's login item is turned off in System Settings › Login Items")
        case .notRegistered, .notFound:
            do {
                try service.register()
                return .handedOff("registered \(label); launchd starts it now and at each login")
            } catch {
                return .runHere("could not register \(label): \(error.localizedDescription)")
            }
        @unknown default:
            return .runHere("unknown login item status \(service.status.rawValue)")
        }
    }

    public struct Unregistered: Equatable, Sendable {
        /// One line for the terminal or the menu's alert.
        public let message: String
        /// True when the login item is gone afterwards, whether or not this call removed it.
        public let ok: Bool
    }

    /// Removes the login item and nothing else: no settings, memory or other data. If the agent is running, launchd
    /// stops it (SMAppService.unregister's documented behavior for a LaunchAgent), so the menu's copy of Caret quits.
    /// Unregistering what is not registered throws kSMErrorJobNotFound; that is reported as already done.
    public static func unregister(_ service: Service) -> Unregistered {
        switch service.status {
        case .notRegistered, .notFound:
            return Unregistered(message: "\(label) is not registered as a login item; nothing to remove", ok: true)
        default:
            break
        }
        do {
            try service.unregister()
            return Unregistered(message: "unregistered \(label): Caret no longer opens at login", ok: true)
        } catch {
            return Unregistered(message: "could not unregister \(label): \(error.localizedDescription)", ok: false)
        }
    }

    private static func kickstart() -> HandOff {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "gui/\(getuid())/\(label)"]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return .runHere("could not start \(label): \(error.localizedDescription)")
        }
        return p.terminationStatus == 0 ? .handedOff("started \(label)") : .runHere("launchctl kickstart \(label) exited \(p.terminationStatus)")
    }
}

extension SMAppService: LoginAgent.Service {}
